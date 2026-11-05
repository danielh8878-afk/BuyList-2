import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ShoppingItem, StoreId } from './src/types';

interface HouseholdData {
  householdId: string;
  items: ShoppingItem[];
  version: number;
  updatedAt: number;
}

const STORE_FILE = path.resolve('sync_store.json');

// In-Memory store backed by JSON file
const households = new Map<string, HouseholdData>();

// Load persisted households on startup
try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed: Record<string, HouseholdData> = JSON.parse(raw);
    for (const [id, data] of Object.entries(parsed)) {
      households.set(id, data);
    }
    console.log(`[Sync] ${households.size} Haushalt(e) aus Speicher geladen.`);
  }
} catch (e) {
  console.warn('[Sync] Konnte sync_store.json nicht lesen:', e);
}

function saveStoreToDisk() {
  try {
    const obj: Record<string, HouseholdData> = {};
    for (const [id, data] of households.entries()) {
      obj[id] = data;
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Sync] Fehler beim Speichern von sync_store.json:', e);
  }
}

// Track connected WebSocket clients per household
const roomClients = new Map<string, Set<WebSocket>>();
const clientMetadata = new Map<WebSocket, { householdId: string; deviceName?: string; isAlive: boolean }>();

function getHousehold(id: string): HouseholdData {
  const normalizedId = (id || 'default').trim().toUpperCase();
  let household = households.get(normalizedId);
  if (!household) {
    household = {
      householdId: normalizedId,
      items: [],
      version: 0,
      updatedAt: Date.now(),
    };
    households.set(normalizedId, household);
  }
  return household;
}

function getConnectedCount(householdId: string): number {
  const normalized = householdId.trim().toUpperCase();
  return roomClients.get(normalized)?.size || 0;
}

function broadcastToRoom(householdId: string, payload: any, senderToExclude?: WebSocket) {
  const normalized = householdId.trim().toUpperCase();
  const clients = roomClients.get(normalized);
  if (!clients) return;

  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== senderToExclude && client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg);
      } catch (err) {
        console.error('[Sync] Send error:', err);
      }
    }
  }
}

function broadcastPresence(householdId: string) {
  const count = getConnectedCount(householdId);
  broadcastToRoom(householdId, {
    type: 'presence',
    householdId,
    deviceCount: count,
  });
}

export function setupRealtimeSync(server: http.Server, app: Express) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade specifically for /ws
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch (e) {
      // Ignore invalid URLs
    }
  });

  wss.on('connection', (ws: WebSocket, req) => {
    let currentHouseholdId = 'DEFAULT';

    // Parse household from query param if available
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const paramHousehold = url.searchParams.get('household');
      if (paramHousehold) {
        currentHouseholdId = paramHousehold.trim().toUpperCase();
      }
    } catch {}

    clientMetadata.set(ws, { householdId: currentHouseholdId, isAlive: true });

    const joinRoom = (hhId: string, deviceName?: string) => {
      // Leave old room if switching
      const oldMeta = clientMetadata.get(ws);
      if (oldMeta && oldMeta.householdId) {
        const oldRoom = roomClients.get(oldMeta.householdId);
        if (oldRoom) {
          oldRoom.delete(ws);
          broadcastPresence(oldMeta.householdId);
        }
      }

      currentHouseholdId = (hhId || 'DEFAULT').trim().toUpperCase();
      clientMetadata.set(ws, { householdId: currentHouseholdId, deviceName, isAlive: true });

      if (!roomClients.has(currentHouseholdId)) {
        roomClients.set(currentHouseholdId, new Set());
      }
      roomClients.get(currentHouseholdId)!.add(ws);

      const household = getHousehold(currentHouseholdId);
      const count = getConnectedCount(currentHouseholdId);

      // Send initial state to the newly connected client
      ws.send(
        JSON.stringify({
          type: 'init',
          householdId: currentHouseholdId,
          items: household.items,
          version: household.version,
          deviceCount: count,
          serverTime: Date.now(),
        })
      );

      // Notify others in room of new device
      broadcastPresence(currentHouseholdId);
    };

    joinRoom(currentHouseholdId);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const meta = clientMetadata.get(ws);
        const hhId = meta?.householdId || currentHouseholdId;
        const household = getHousehold(hhId);

        switch (data.type) {
          case 'join': {
            if (data.householdId) {
              joinRoom(data.householdId, data.deviceName);
            }
            break;
          }

          case 'ping': {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
          }

          case 'sync-full': {
            // Overwrite entire list (e.g. initial upload or list import)
            if (Array.isArray(data.items)) {
              household.items = data.items;
              household.version++;
              household.updatedAt = Date.now();
              saveStoreToDisk();

              broadcastToRoom(hhId, {
                type: 'state-synced',
                householdId: hhId,
                items: household.items,
                version: household.version,
                sourceDevice: meta?.deviceName,
              });
            }
            break;
          }

          case 'add-item': {
            const newItem = data.item as ShoppingItem;
            if (newItem && newItem.id) {
              // Idempotency: verify item doesn't exist already
              const exists = household.items.some((i) => i.id === newItem.id);
              if (!exists) {
                household.items = [newItem, ...household.items];
                household.version++;
                household.updatedAt = Date.now();
                saveStoreToDisk();

                broadcastToRoom(hhId, {
                  type: 'item-added',
                  householdId: hhId,
                  item: newItem,
                  version: household.version,
                }, ws);
              }
            }
            break;
          }

          case 'toggle-item': {
            const { id, completed } = data;
            let updated = false;
            household.items = household.items.map((i) => {
              if (i.id === id) {
                updated = true;
                return { ...i, completed: !!completed };
              }
              return i;
            });

            if (updated) {
              household.version++;
              household.updatedAt = Date.now();
              saveStoreToDisk();

              broadcastToRoom(hhId, {
                type: 'item-toggled',
                householdId: hhId,
                id,
                completed,
                version: household.version,
              }, ws);
            }
            break;
          }

          case 'update-item': {
            const { id, updates } = data;
            let updated = false;
            household.items = household.items.map((i) => {
              if (i.id === id) {
                updated = true;
                return { ...i, ...updates };
              }
              return i;
            });

            if (updated) {
              household.version++;
              household.updatedAt = Date.now();
              saveStoreToDisk();

              broadcastToRoom(hhId, {
                type: 'item-updated',
                householdId: hhId,
                id,
                updates,
                version: household.version,
              }, ws);
            }
            break;
          }

          case 'delete-item': {
            const { id } = data;
            const originalLength = household.items.length;
            household.items = household.items.filter((i) => i.id !== id);

            if (household.items.length !== originalLength) {
              household.version++;
              household.updatedAt = Date.now();
              saveStoreToDisk();

              broadcastToRoom(hhId, {
                type: 'item-deleted',
                householdId: hhId,
                id,
                version: household.version,
              }, ws);
            }
            break;
          }

          case 'clear-completed': {
            const storeFilter = data.store as StoreId | 'all' | undefined;
            household.items = household.items.filter((i) => {
              if (!i.completed) return true;
              if (storeFilter && storeFilter !== 'all') {
                return i.store !== storeFilter;
              }
              return false;
            });

            household.version++;
            household.updatedAt = Date.now();
            saveStoreToDisk();

            broadcastToRoom(hhId, {
              type: 'state-synced',
              householdId: hhId,
              items: household.items,
              version: household.version,
            });
            break;
          }
        }
      } catch (err) {
        console.error('[Sync] Error processing WS message:', err);
      }
    });

    ws.on('close', () => {
      const meta = clientMetadata.get(ws);
      if (meta?.householdId) {
        const room = roomClients.get(meta.householdId);
        if (room) {
          room.delete(ws);
          if (room.size === 0) {
            roomClients.delete(meta.householdId);
          }
        }
        broadcastPresence(meta.householdId);
      }
      clientMetadata.delete(ws);
    });

    ws.on('error', (err) => {
      console.warn('[Sync] Client WebSocket error:', err.message);
    });
  });

  // REST API Endpoints for fallback polling and initial checks
  app.get('/api/sync/:householdId', (req: Request, res: Response) => {
    const hh = getHousehold(req.params.householdId);
    res.json({
      success: true,
      householdId: hh.householdId,
      items: hh.items,
      version: hh.version,
      updatedAt: hh.updatedAt,
      deviceCount: getConnectedCount(hh.householdId),
    });
  });

  app.post('/api/sync/:householdId', (req: Request, res: Response) => {
    const hhId = req.params.householdId.trim().toUpperCase();
    const { items, version } = req.body;
    const hh = getHousehold(hhId);

    if (Array.isArray(items)) {
      hh.items = items;
      hh.version = (typeof version === 'number' ? version : hh.version) + 1;
      hh.updatedAt = Date.now();
      saveStoreToDisk();

      // Broadcast to any active WebSockets
      broadcastToRoom(hhId, {
        type: 'state-synced',
        householdId: hhId,
        items: hh.items,
        version: hh.version,
      });
    }

    res.json({
      success: true,
      householdId: hh.householdId,
      items: hh.items,
      version: hh.version,
      updatedAt: hh.updatedAt,
      deviceCount: getConnectedCount(hhId),
    });
  });
}
