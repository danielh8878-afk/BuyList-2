# BuyList - Android APK & Installation auf dem Smartphone

Diese Anleitung bietet dir 3 Wege, um **BuyList** auf deinem Android-Smartphone zu nutzen:

---

## ⚡ Weg 1: Sofort ohne PC auf Android installieren (Empfohlen!)
Die App ist eine vollwertige **Progressive Web App (PWA)**:
1. Öffne den Link dieser App auf deinem Android-Smartphone in **Google Chrome**.
2. Tippe oben rechts auf das Drei-Punkte-Menü (`⋮`).
3. Wähle **"App installieren"** oder **"Zum Startbildschirm hinzufügen"**.
4. ✅ **Fertig!** Die App hat ihr eigenes BuyList-Icon auf dem Homescreen, öffnet im echten Vollbild (ohne Browser-Adressleiste), hat Kamerazugriff für den Kassenbon-Scanner und speichert deine Daten offline auf dem Smartphone.

---

## 🚀 Weg 2: APK automatisch via GitHub Actions bauen (Kostenlos & ohne lokale Software)
Das Projekt enthält bereits den fertigen Workflow `.github/workflows/build-apk.yml`:
1. Lade das Projekt-ZIP über den Download-Button in der App herunter.
2. Erstelle ein Repository auf [GitHub](https://github.com) und lade die Dateien hoch.
3. GitHub Actions startet automatisch den Android-Build mit Java & Gradle.
4. Unter dem Reiter **Actions** > **Build Android APK** kannst du die fertige **`BuyList-Debug-APK.zip`** direkt herunterladen, entpacken und die `app-debug.apk` auf deinem Android-Handy installieren!

---

## 💻 Weg 3: Native APK lokal mit Android Studio kompilieren
Das Projekt ist bereits mit `capacitor.config.json` vorkonfiguriert:

### Schritt 1: Lokale Abhängigkeiten installieren
```bash
npm install
npm run build
```

### Schritt 2: Android Plattform hinzufügen
```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync android
```

### Schritt 3: In Android Studio öffnen
```bash
npx cap open android
```

### Schritt 4: APK generieren
1. In Android Studio im oberen Menü auf:
   **Build** > **Build Bundle(s) / APK(s)** > **Build APK(s)**
2. Die fertige `app-debug.apk` wird im Ordner `android/app/build/outputs/apk/debug/` erzeugt.
3. Übertrage die `.apk` auf dein Smartphone (z. B. per USB, Google Drive oder WhatsApp) und tippe zum Installieren darauf.
