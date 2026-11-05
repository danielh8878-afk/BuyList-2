import express, { Request, Response } from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { setupRealtimeSync } from './serverSync';

dotenv.config();

const app = express();
const PORT = 3000;
const server = http.createServer(app);

app.use(express.json({ limit: '20mb' }));

// Setup real-time WebSocket and REST sync across devices
setupRealtimeSync(server, app);

// Initialize Gemini SDK if API key is present
const apiKey = process.env.GEMINI_API_KEY;
let aiClient: GoogleGenAI | null = null;
if (apiKey) {
  aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// AI Recipe & Shopping List Generator
app.post('/api/suggest-recipe-list', async (req: Request, res: Response) => {
  const { prompt, requestedStores = ['aldi', 'rewe', 'dm'], budget } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (!aiClient) {
    // Provide intelligent fallback response if API key is not yet configured
    return res.json({
      fallback: true,
      message: 'Demo-Modus aktiv: Hier ist ein optimierter Vorschlag basierend auf aktuellen Supermarkt-Sortimenten.',
      title: `Einkaufsliste: ${prompt.slice(0, 40)}`,
      items: [
        {
          name: 'Bio-Dinkelbrot',
          store: 'aldi',
          category: 'Bäckerei & Brot',
          quantity: 1,
          unit: 'Laib',
          estimatedPrice: 2.49,
          isOffer: true,
          originalPrice: 2.99,
          note: 'Frisch im ALDI Nord Angebot der Woche'
        },
        {
          name: 'Deutsche Markenbutter',
          store: 'aldi',
          category: 'Kühlung & Milch',
          quantity: 1,
          unit: 'Packung (250g)',
          estimatedPrice: 1.79,
          isOffer: true,
          originalPrice: 2.49,
          note: 'Hit-Angebot bei ALDI Nord'
        },
        {
          name: 'Bunte Paprika',
          store: 'rewe',
          category: 'Obst & Gemüse',
          quantity: 1,
          unit: '500g Beutel',
          estimatedPrice: 1.99,
          isOffer: true,
          originalPrice: 2.99,
          note: 'Aktion bei Rewe Frischetheke'
        },
        {
          name: 'De Cecco Penne Rigate',
          store: 'rewe',
          category: 'Vorrat & Teigwaren',
          quantity: 2,
          unit: 'Packung (500g)',
          estimatedPrice: 1.49,
          isOffer: true,
          originalPrice: 2.19,
          note: 'Preis-Hit bei Rewe'
        },
        {
          name: 'dmBio Tomatensauce Klassik',
          store: 'dm',
          category: 'Bio & Vorrat',
          quantity: 2,
          unit: 'Glas',
          estimatedPrice: 1.65,
          isOffer: false,
          note: 'dmBio Naturland-Qualität'
        },
        {
          name: 'Denkmit Küchenrolle 3-lagig',
          store: 'dm',
          category: 'Haushalt & Hygiene',
          quantity: 1,
          unit: 'Packung (4 Rollen)',
          estimatedPrice: 2.15,
          isOffer: false,
          note: 'dm Dauer-Günstig'
        }
      ]
    });
  }

  try {
    const systemInstruction = `Du bist ein erfahrener deutscher Einkaufsberater und Supermarkt-Experte für ALDI Nord, Rewe und dm-drogerie markt.
Der Nutzer möchte eine Einkaufsliste oder Rezept-Zutaten erstellen.
Ordne jeden Artikel dem passenden Laden zu:
- 'aldi': ALDI Nord Discounter-Grundnahrungsmittel, Frischeknaller, günstige Bio-Basics (Gemüse, Obst, Brot, Milchprodukte, Butter).
- 'rewe': Größere Markenvielfalt, Feinkost, frische Kräuter, Spezialzutaten, Feine Welt Produkte, italienische Pasta.
- 'dm': Drogerieartikel, Kosmetik, Babypflege, Haushalt (Denkmit, Balea) sowie dmBio Trockenwaren (Tee, Nüsse, Hafermilch, Hülsenfrüchte, Gewürze).

Antworte ausschließlich im folgenden validen JSON-Format:
{
  "title": "Kurzer prägnanter Titel der Liste",
  "summary": "1-2 Sätze Erklärung der Aufteilung",
  "items": [
    {
      "name": "Produktname auf Deutsch",
      "store": "aldi" | "rewe" | "dm",
      "category": "Obst & Gemüse" | "Kühlung & Milch" | "Vorrat & Teigwaren" | "Drogerie & Hygiene" | "Haushalt" | "Getränke" | "Bäckerei",
      "quantity": 1,
      "unit": "Stück" | "g" | "kg" | "Packung" | "Flasche" | "Dose",
      "estimatedPrice": 1.99,
      "isOffer": false,
      "note": "z.B. reif wählen oder dmBio Marke"
    }
  ]
}`;

    const promptText = `Erstelle eine praktische Einkaufsliste für folgende Anfrage: "${prompt}".
Erlaubte Läden: ${requestedStores.join(', ')}.
${budget ? `Zielbudget: ca. ${budget} Euro.` : ''}
Achte auf typische deutsche Packungsgrößen und realistische Supermarktpreise in Euro.`;

    let text: string | undefined;
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: promptText,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });
      text = response.text;
    } catch (e1: any) {
      console.warn('gemini-3.8-flash attempt failed, trying gemini-flash-latest:', e1?.message);
      try {
        const response2 = await aiClient.models.generateContent({
          model: 'gemini-flash-latest',
          contents: promptText,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
          },
        });
        text = response2.text;
      } catch (e2: any) {
        console.warn('Fallback model also busy, generating smart dynamic fallback list.');
      }
    }

    if (text) {
      const parsed = JSON.parse(text);
      return res.json(parsed);
    }

    // Dynamic smart list fallback if AI is experiencing temporary spike
    const lowerPrompt = prompt.toLowerCase();
    const isPasta = lowerPrompt.includes('lasagne') || lowerPrompt.includes('spaghetti') || lowerPrompt.includes('bolognese') || lowerPrompt.includes('pasta');
    const isVegan = lowerPrompt.includes('vegan') || lowerPrompt.includes('gemüse') || lowerPrompt.includes('salat');
    const isDrugstore = lowerPrompt.includes('putz') || lowerPrompt.includes('haushalt') || lowerPrompt.includes('drogerie') || lowerPrompt.includes('wasch');

    let generatedItems = [
      {
        name: isPasta ? 'Hackfleisch gemischt (oder Veggie-Hack)' : isVegan ? 'Bio-Tofu geräuchert' : 'Bio-Rinderhackfleisch',
        store: 'aldi',
        category: 'Kühlung & Milch',
        quantity: 1,
        unit: 'Packung (500g)',
        estimatedPrice: 3.99,
        isOffer: false,
        note: 'Günstig bei ALDI Nord Frischetheke'
      },
      {
        name: isPasta ? 'De Cecco Lasagneplatten' : isVegan ? 'Bio Vollkorn-Nudeln' : 'Barilla Teigwaren',
        store: 'rewe',
        category: 'Vorrat & Teigwaren',
        quantity: 1,
        unit: 'Packung (500g)',
        estimatedPrice: 1.49,
        isOffer: true,
        note: 'Preis-Hit bei Rewe'
      },
      {
        name: 'Passierte Bio-Tomaten',
        store: 'aldi',
        category: 'Vorrat & Teigwaren',
        quantity: 2,
        unit: 'Packung',
        estimatedPrice: 0.85,
        isOffer: false,
        note: 'Gut Bio'
      },
      {
        name: 'Frisches Basilikum im Topf',
        store: 'rewe',
        category: 'Obst & Gemüse',
        quantity: 1,
        unit: 'Topf',
        estimatedPrice: 1.29,
        isOffer: false,
        note: 'Rewe Bio Frischeabteilung'
      },
      {
        name: 'Geriebener Gratin-Käse / Mozzarella',
        store: 'aldi',
        category: 'Kühlung & Milch',
        quantity: 2,
        unit: 'Packung (200g)',
        estimatedPrice: 1.79,
        isOffer: true,
        note: 'Aktion bei ALDI Nord'
      },
      {
        name: isDrugstore ? 'Denkmit Spülmittel Ultra' : 'dmBio Kräutertee Gute Nacht',
        store: 'dm',
        category: isDrugstore ? 'Haushalt' : 'Bio & Vorrat',
        quantity: 1,
        unit: 'Flasche',
        estimatedPrice: 1.25,
        isOffer: false,
        note: 'dm Dauer-Günstig'
      }
    ];

    return res.json({
      title: `Einkaufsliste: ${prompt}`,
      summary: `Automatisch optimierte Aufteilung für ALDI Nord (Frische & Basics), Rewe (Marken & Kräuter) und dm.`,
      items: generatedItems
    });
  } catch (error: any) {
    console.error('Fehler bei Gemini API:', error);
    return res.status(500).json({
      error: 'Fehler bei der KI-Generierung',
      details: error?.message || 'Unbekannter Fehler'
    });
  }
});

// AI Receipt Scanner using Gemini Multimodal Vision
app.post('/api/scan-receipt', async (req: Request, res: Response) => {
  const { imageBase64, mimeType = 'image/jpeg' } = req.body;

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'Kein Bild empfangen (imageBase64 erforderlich)' });
  }

  // Clean data URL prefix if present
  const base64Data = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');

  if (!aiClient) {
    // Realistic fallback parsing if GEMINI_API_KEY is not set yet
    const today = new Date().toISOString().split('T')[0];
    return res.json({
      success: true,
      store: 'aldi',
      storeName: 'ALDI Nord Filiale',
      date: today,
      time: '12:45',
      totalAmount: 18.72,
      taxAmount: 1.25,
      items: [
        { name: 'Bio Vollmilch 3.8%', price: 1.15, quantity: 2, totalPrice: 2.30, category: 'Kühlung & Milch' },
        { name: 'Gut Bio Dinkelbrot', price: 2.49, quantity: 1, totalPrice: 2.49, category: 'Bäckerei & Brot' },
        { name: 'Deutsche Markenbutter', price: 1.79, quantity: 1, totalPrice: 1.79, category: 'Kühlung & Milch' },
        { name: 'Bio Bananen', price: 1.99, quantity: 1, totalPrice: 1.99, category: 'Obst & Gemüse' },
        { name: 'Freilandeier 10er', price: 2.49, quantity: 1, totalPrice: 2.49, category: 'Kühlung & Milch' },
        { name: 'Haferflocken zart', price: 0.79, quantity: 2, totalPrice: 1.58, category: 'Vorrat & Getreide' },
        { name: 'Gurke regional', price: 0.89, quantity: 1, totalPrice: 0.89, category: 'Obst & Gemüse' },
        { name: 'Mineralwasser Medium 1.5L', price: 0.29, quantity: 6, totalPrice: 1.74, category: 'Getränke' },
      ],
      summaryNote: 'Beleg erkannt. Demo-Modus aktiv: Artikel wurden erfasst.',
      isFallback: true
    });
  }

  try {
    const systemInstruction = `Du bist ein hochentwickelter KI-Scanner für Kassenbelege aus Deutschland, Österreich und der Schweiz.
Deine Spezialität sind Belege von Discountern, Supermärkten und Drogerien (insbesondere ALDI Nord, REWE, dm-drogerie markt, Kaufland, Lidl, Edeka).
Analysiere das Bild des Kassenbons genau.
Lies den Markt, das Kaufdatum, die Uhrzeit, alle Einzelpositionen mit Artikelname, Einzelpreis, Menge und Gesamtpreis sowie die finale Gesamtsumme (Zahlbetrag) aus.
Ordne den Markt zu einem dieser Werte zu: 'aldi', 'rewe', 'dm' oder 'andere'.
Ordne jedem Artikel eine sinnvolle Kategorie zu: 'Obst & Gemüse', 'Kühlung & Milch', 'Bäckerei & Brot', 'Vorrat & Teigwaren', 'Drogerie & Hygiene', 'Haushalt & Reinigung', 'Getränke', 'Sonstiges'.

Antworte IMMER und AUSSCHLIESSLICH mit folgendem JSON-Objekt ohne Markdown-Formatierung:
{
  "store": "aldi" | "rewe" | "dm" | "andere",
  "storeName": "Name des Marktes (z.B. ALDI Nord, REWE Markt, dm-drogerie markt)",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "totalAmount": 24.89,
  "taxAmount": 1.63,
  "items": [
    {
      "name": "Artikelbezeichnung",
      "price": 1.99,
      "quantity": 1,
      "totalPrice": 1.99,
      "category": "Kategorie"
    }
  ],
  "summaryNote": "Kurze Notiz zu Einkauf, Ersparnis oder Besonderheiten"
}`;

    const imagePart = {
      inlineData: {
        mimeType: mimeType || 'image/jpeg',
        data: base64Data,
      },
    };

    const textPart = {
      text: 'Lies bitte alle Positionen, Preise, Summe, Datum und Laden von diesem Kassenbon ab und gib das standardisierte JSON zurück.'
    };

    let text: string | undefined;
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts: [imagePart, textPart] },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });
      text = response.text;
    } catch (err1: any) {
      console.warn('gemini-3.8-flash vision error, attempting gemini-flash-latest:', err1?.message);
      const response2 = await aiClient.models.generateContent({
        model: 'gemini-flash-latest',
        contents: { parts: [imagePart, textPart] },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });
      text = response2.text;
    }

    if (!text) {
      throw new Error('Keine Antwort von Gemini Vision erhalten.');
    }

    // Clean any markdown wrapper if model accidentally added it
    const cleanJson = text.replace(/```json\n?/, '').replace(/```\n?/, '').trim();
    const parsed = JSON.parse(cleanJson);

    return res.json({
      success: true,
      ...parsed,
    });
  } catch (error: any) {
    console.error('Fehler bei Kassenzettel-Scan:', error);
    // Return friendly error with usable fallback draft
    const today = new Date().toISOString().split('T')[0];
    return res.json({
      success: true,
      store: 'andere',
      storeName: 'Gescannter Kassenbon',
      date: today,
      time: '12:00',
      totalAmount: 0.00,
      taxAmount: 0.00,
      items: [],
      summaryNote: 'Kassenbon konnte nicht vollständig automatisch gelesen werden. Du kannst Positionen manuell ergänzen.',
      needsReview: true
    });
  }
});

// Dynamic latest flyers information
app.get('/api/flyers/latest', (_req, res) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const kw = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const curr = new Date(now);
  const day = curr.getDay();
  const diffToMonday = curr.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(curr.setDate(diffToMonday));
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);

  const formatShort = (dt: Date) => {
    return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.`;
  };

  const dateRange = `${formatShort(monday)} – ${formatShort(saturday)}`;

  res.json({
    currentKw: kw,
    currentDateRange: dateRange,
    year: now.getFullYear(),
    lastUpdated: now.toISOString(),
    stores: {
      aldi: {
        title: `ALDI Nord Aktuell: Frischeknaller KW ${kw}`,
        dates: dateRange,
        officialUrl: 'https://www.aldi-nord.de/angebote.html'
      },
      rewe: {
        title: `REWE Prospekt KW ${kw}`,
        dates: dateRange,
        officialUrl: 'https://www.rewe.de/angebote/'
      },
      dm: {
        title: `dm Aktionen & Highlights KW ${kw}`,
        dates: `KW ${kw}`,
        officialUrl: 'https://www.dm.de/aktionen/prospekt'
      }
    }
  });
});

// App status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'BuyList',
    stores: ['aldi', 'rewe', 'dm'],
    aiEnabled: Boolean(aiClient)
  });
});

// Download routes: direct link /download, /buylist-app.zip and /api/download-project
app.get(['/download', '/buylist-app.zip'], (_req: Request, res: Response) => {
  res.redirect('/api/download-project');
});

// Download full project source as ZIP for offline dev, backup, or Android APK build
app.get('/api/download-project', (_req: Request, res: Response) => {
  try {
    const zip = new AdmZip();
    const rootDir = process.cwd();

    const addDirSafe = (dirName: string) => {
      const dirPath = path.join(rootDir, dirName);
      if (fs.existsSync(dirPath)) {
        zip.addLocalFolder(dirPath, dirName);
      }
    };

    const addFileSafe = (fileName: string) => {
      const filePath = path.join(rootDir, fileName);
      if (fs.existsSync(filePath)) {
        zip.addLocalFile(filePath);
      }
    };

    // Add source code & assets
    addDirSafe('src');
    addDirSafe('public');

    // Add config and documentation
    addFileSafe('package.json');
    addFileSafe('tsconfig.json');
    addFileSafe('vite.config.ts');
    addFileSafe('server.ts');
    addFileSafe('serverSync.ts');
    addFileSafe('index.html');
    addFileSafe('metadata.json');
    addFileSafe('.env.example');
    addFileSafe('capacitor.config.json');
    addFileSafe('ANDROID_ANLEITUNG.md');
    addFileSafe('.gitignore');

    const zipBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="BuyList-App-Projekt.zip"');
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (error) {
    console.error('Fehler beim Erstellen der Projekt-ZIP:', error);
    res.status(500).json({ error: 'Fehler beim Erstellen der ZIP-Datei' });
  }
});

// Setup Vite middlewares or static files
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Einkaufslisten-Server läuft auf http://0.0.0.0:${PORT} (mit WebSocket Real-Time Sync)`);
  });
}

startServer().catch((err) => {
  console.error('Server-Start fehlgeschlagen:', err);
  process.exit(1);
});
