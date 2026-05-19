const express = require("express");
const path = require("path");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = "p.telsemeyer@zoeger.de";
const EMAIL_FROM = "onboarding@resend.dev"; // Später: agent@zoeger.de nach Domain-Verifizierung

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname)));

// ── CLAUDE API PROXY ─────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY nicht gesetzt" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMMOBILIEN-SUCHE MIT CLAUDE + WEB SEARCH ─────────────────────────────────
async function searchNewListings() {
  console.log("🔍 Starte tägliche Immobilien-Suche für Hamm...");

  const prompt = `Suche nach aktuellen Immobilienangeboten in Hamm (NRW) von heute oder den letzten 24 Stunden auf ImmobilienScout24, Immowelt und Kleinanzeigen.

Kategorien:
- Einfamilienhäuser (EFH)
- Eigentumswohnungen (ETW)
- Mehrfamilienhäuser (MFH)
- Anlageobjekte
- Gewerbe

Für jedes gefundene Angebot bitte folgendes ausgeben:
- Titel
- Preis
- Größe (m²) und Zimmer falls vorhanden
- Adresse/Lage in Hamm
- Quelle (IS24/Immowelt/Kleinanzeigen)
- Link

Strukturiere die Ergebnisse nach Kategorie. Falls keine neuen Angebote gefunden werden, schreibe das klar hin.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Claude API Fehler");

  const text = data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  return text;
}

// ── E-MAIL VERSAND MIT RESEND ─────────────────────────────────────────────────
async function sendEmail(listings) {
  if (!RESEND_API_KEY) {
    console.error("❌ RESEND_API_KEY nicht gesetzt");
    return;
  }

  const today = new Date().toLocaleDateString("de-DE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // Listings-Text in HTML umwandeln
  const htmlContent = listings
    .split("\n")
    .map(line => {
      if (line.startsWith("##") || line.startsWith("**")) {
        return `<h3 style="color:#b8943a;margin-top:24px;margin-bottom:8px;">${line.replace(/[#*]/g, "").trim()}</h3>`;
      }
      if (line.startsWith("-") || line.startsWith("•")) {
        return `<li style="margin-bottom:4px;">${line.replace(/^[-•]\s*/, "")}</li>`;
      }
      if (line.trim() === "") return "<br/>";
      return `<p style="margin:4px 0;">${line}</p>`;
    })
    .join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:680px;margin:0 auto;background:#ffffff;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#b8943a,#8a6820);padding:28px 32px;">
    <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;letter-spacing:-0.5px;">Zoeger Immobilien</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px;">Tägliches Marktbriefing · ${today}</p>
  </div>

  <!-- Intro -->
  <div style="padding:24px 32px 0;background:#f7f8fa;border-left:4px solid #b8943a;">
    <p style="margin:0;font-size:14px;color:#4a5568;line-height:1.6;">
      Hier sind die neuen Immobilienangebote in <strong>Hamm (NRW)</strong> von heute –
      aus ImmobilienScout24, Immowelt und Kleinanzeigen.
    </p>
  </div>

  <!-- Content -->
  <div style="padding:24px 32px;background:#ffffff;font-size:14px;color:#1a1d2e;line-height:1.7;">
    ${htmlContent}
  </div>

  <!-- Footer -->
  <div style="padding:20px 32px;background:#f7f8fa;border-top:1px solid #e8edf3;">
    <p style="margin:0;font-size:12px;color:#8a95a8;">
      Zoeger Immobilien · Hamm (NRW) · Automatisch generiert von deinem KI-Agenten
    </p>
  </div>

</body>
</html>`;

  const emailResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `🏠 Neue Immobilien in Hamm – ${today}`,
      html,
    }),
  });

  const result = await emailResponse.json();
  if (!emailResponse.ok) throw new Error(result.message || "Resend Fehler");

  console.log(`✅ E-Mail gesendet an ${EMAIL_TO} (ID: ${result.id})`);
  return result;
}

// ── CRONJOB: Täglich um 07:00 Uhr ────────────────────────────────────────────
cron.schedule("0 7 * * *", async () => {
  console.log("⏰ Cronjob gestartet: Tägliches Immobilien-Briefing");
  try {
    const listings = await searchNewListings();
    await sendEmail(listings);
  } catch (err) {
    console.error("❌ Fehler beim täglichen Briefing:", err.message);
  }
}, {
  timezone: "Europe/Berlin"
});

// ── MANUELLER TEST-ENDPUNKT ──────────────────────────────────────────────────
// Aufruf: POST /api/send-briefing (zum Testen ohne auf 7 Uhr zu warten)
app.post("/api/send-briefing", async (req, res) => {
  try {
    console.log("📧 Manueller Versand gestartet...");
    const listings = await searchNewListings();
    await sendEmail(listings);
    res.json({ success: true, message: "Briefing erfolgreich gesendet!" });
  } catch (err) {
    console.error("❌ Fehler:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SERVER START ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Zoeger Immobilien Agent läuft auf Port ${PORT}`);
  console.log(`📅 Tägliches Briefing: 07:00 Uhr (Europe/Berlin)`);
  console.log(`📧 Empfänger: ${EMAIL_TO}`);
});
