const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = "p.telsemeyer@zoeger.de";
const EMAIL_FROM = "onboarding@resend.dev";
const LISTINGS_FILE = path.join(__dirname, "seen_listings.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname)));

// CLAUDE PROXY
app.post("/api/chat", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY nicht gesetzt" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GESPEICHERTE INSERATE
function loadSeenListings() {
  try {
    if (fs.existsSync(LISTINGS_FILE)) return JSON.parse(fs.readFileSync(LISTINGS_FILE, "utf8"));
  } catch (e) {}
  return { date: null, listings: [] };
}

function saveListings(listings) {
  const today = new Date().toISOString().split("T")[0];
  fs.writeFileSync(LISTINGS_FILE, JSON.stringify({ date: today, listings }, null, 2));
}

// INSERATE SUCHEN
async function fetchListings() {
  const prompt = `Suche auf ImmobilienScout24, Immowelt und Kleinanzeigen nach aktuellen Immobilien zum Kauf in Hamm NRW.
Kategorien: Einfamilienhäuser, Eigentumswohnungen, Mehrfamilienhäuser, Anlageobjekte, Gewerbe.

Gib NUR dieses JSON zurück, kein anderer Text:
{"listings":[{"id":"url","titel":"Titel","preis":"Preis","groesse":"m² Zimmer","lage":"Stadtteil","kategorie":"EFH oder ETW oder MFH oder Anlage oder Gewerbe","quelle":"IS24 oder Immowelt oder Kleinanzeigen","url":"https://vollstaendige-url"}]}

Nur echte Inserate mit echter URL. Mindestens 15 Inserate.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Claude Fehler");
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("Kein JSON");
    const parsed = JSON.parse(text.slice(s, e + 1));
    return parsed.listings || [];
  } catch (e) {
    console.error("Parse Fehler:", e.message);
    return [];
  }
}

// NEUE INSERATE
function findNewListings(today, seenData) {
  const seenIds = new Set((seenData.listings || []).map(l => l.id || l.url));
  return today.filter(l => !seenIds.has(l.id || l.url));
}

// EMAIL HTML
function buildEmailHtml(newListings, totalToday) {
  const today = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dateShort = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

  const portale = [
    {
      id: "IS24",
      label: "ImmobilienScout24",
      color: "#003da5",
      lightColor: "#e8eef9",
      icon: "🔵",
    },
    {
      id: "Immowelt",
      label: "Immowelt",
      color: "#e8000d",
      lightColor: "#fde8e9",
      icon: "🔴",
    },
    {
      id: "Kleinanzeigen",
      label: "Kleinanzeigen",
      color: "#f0a500",
      lightColor: "#fef6e0",
      icon: "🟡",
    },
  ];

  const kategorieLabels = {
    "EFH": "Einfamilienhaus",
    "ETW": "Eigentumswohnung",
    "MFH": "Mehrfamilienhaus",
    "Anlage": "Anlageobjekt",
    "Gewerbe": "Gewerbe",
  };

  const kategorieIcons = {
    "EFH": "🏠",
    "ETW": "🏢",
    "MFH": "🏘️",
    "Anlage": "📈",
    "Gewerbe": "🏭",
  };

  let portalSections = "";

  portale.forEach(portal => {
    const items = newListings.filter(l => l.quelle === portal.id);
    if (!items.length) return;

    // Tabelle mit Zeilen
    let rows = "";
    items.forEach((l, i) => {
      const bg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
      rows += `
        <tr style="background:${bg};">
          <td style="padding:12px 14px;border-bottom:1px solid #edf0f4;vertical-align:top;">
            <span style="background:${portal.lightColor};color:${portal.color};font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;letter-spacing:0.3px;">${kategorieIcons[l.kategorie] || ""} ${kategorieLabels[l.kategorie] || l.kategorie}</span>
            <div style="margin-top:5px;font-size:13px;font-weight:600;color:#1a1d2e;line-height:1.4;">${l.titel}</div>
            <div style="margin-top:3px;font-size:12px;color:#8a95a8;">📍 ${l.lage || "Hamm"}</div>
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #edf0f4;vertical-align:middle;white-space:nowrap;text-align:center;">
            <span style="font-size:14px;font-weight:700;color:#1a1d2e;">${l.preis}</span>
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #edf0f4;vertical-align:middle;white-space:nowrap;text-align:center;">
            <span style="font-size:12px;color:#64748b;">${l.groesse || "–"}</span>
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #edf0f4;vertical-align:middle;text-align:center;">
            <a href="${l.url}" style="display:inline-block;background:${portal.color};color:#ffffff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:11px;font-weight:700;letter-spacing:0.3px;">ÖFFNEN →</a>
          </td>
        </tr>`;
    });

    portalSections += `
      <!-- PORTAL: ${portal.label} -->
      <div style="margin-bottom:32px;">

        <!-- Portal Header -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:0;">
          <tr>
            <td style="background:${portal.color};padding:14px 20px;border-radius:10px 10px 0 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.3px;">${portal.label}</span>
                  </td>
                  <td style="text-align:right;">
                    <span style="background:rgba(255,255,255,0.2);color:#ffffff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:10px;">${items.length} neue Inserate</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Tabelle -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #edf0f4;border-top:none;border-radius:0 0 10px 10px;overflow:hidden;">
          <!-- Tabellenkopf -->
          <thead>
            <tr style="background:#f4f5f7;">
              <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:#8a95a8;letter-spacing:0.8px;text-transform:uppercase;border-bottom:2px solid ${portal.color};">OBJEKT &amp; LAGE</th>
              <th style="padding:10px 14px;text-align:center;font-size:10px;font-weight:700;color:#8a95a8;letter-spacing:0.8px;text-transform:uppercase;border-bottom:2px solid ${portal.color};white-space:nowrap;">PREIS</th>
              <th style="padding:10px 14px;text-align:center;font-size:10px;font-weight:700;color:#8a95a8;letter-spacing:0.8px;text-transform:uppercase;border-bottom:2px solid ${portal.color};">GRÖSSE</th>
              <th style="padding:10px 14px;text-align:center;font-size:10px;font-weight:700;color:#8a95a8;letter-spacing:0.8px;text-transform:uppercase;border-bottom:2px solid ${portal.color};"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });

  // Keine neuen Inserate
  if (!newListings.length) {
    portalSections = `
      <div style="text-align:center;padding:50px 20px;background:#f7f8fa;border-radius:12px;border:1px solid #e8edf3;">
        <div style="font-size:40px;margin-bottom:12px;">✓</div>
        <p style="font-size:15px;font-weight:600;color:#1a1d2e;margin:0 0 6px;">Keine neuen Inserate heute</p>
        <p style="font-size:13px;color:#8a95a8;margin:0;">Alle ${totalToday} Inserate am Markt waren bereits gestern bekannt.</p>
      </div>`;
  }

  // Zusammenfassung nach Kategorie
  const kats = ["EFH","ETW","MFH","Anlage","Gewerbe"];
  let summaryRows = kats.map(k => {
    const count = newListings.filter(l => l.kategorie === k).length;
    if (!count) return "";
    return `<td style="text-align:center;padding:10px 16px;border-right:1px solid #e8edf3;">
      <div style="font-size:18px;">${kategorieIcons[k]}</div>
      <div style="font-size:18px;font-weight:700;color:#b8943a;margin:2px 0;">${count}</div>
      <div style="font-size:10px;color:#8a95a8;text-transform:uppercase;letter-spacing:0.5px;">${kategorieLabels[k]}</div>
    </td>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Neue Inserate Hamm – ${dateShort}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <!-- HEADER -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#b8943a 0%,#8a6820 100%);border-radius:12px 12px 0 0;">
      <tr>
        <td style="padding:28px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Zoeger Immobilien</div>
                <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px;">Marktübersicht Hamm · ${today}</div>
              </td>
              <td style="text-align:right;vertical-align:top;">
                <div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:10px 16px;display:inline-block;">
                  <div style="font-size:28px;font-weight:700;color:#ffffff;line-height:1;">${newListings.length}</div>
                  <div style="font-size:10px;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Neue Inserate</div>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- ZUSAMMENFASSUNG -->
  ${summaryRows ? `
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e8edf3;border-right:1px solid #e8edf3;border-bottom:1px solid #e8edf3;">
      <tr style="border-bottom:1px solid #e8edf3;">
        <td style="padding:8px 16px;background:#fdf8ef;border-bottom:1px solid #e8edf3;">
          <span style="font-size:11px;font-weight:700;color:#b8943a;text-transform:uppercase;letter-spacing:0.5px;">Heute neu nach Kategorie</span>
          <span style="font-size:11px;color:#8a95a8;margin-left:12px;">${totalToday} Inserate gesamt am Markt</span>
        </td>
      </tr>
      <tr>${summaryRows}</tr>
    </table>
  </td></tr>` : ""}

  <!-- PORTAL SEKTIONEN -->
  <tr><td style="padding:24px 0 0;">
    ${portalSections}
  </td></tr>

  <!-- FOOTER -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1d2e;border-radius:0 0 12px 12px;">
      <tr>
        <td style="padding:20px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size:13px;font-weight:600;color:#ffffff;">Zoeger Immobilien · Hamm (NRW)</div>
                <div style="font-size:11px;color:#8a95a8;margin-top:4px;">Automatisch generiert · Täglich 07:00 Uhr · KI-gestützte Marktbeobachtung</div>
              </td>
              <td style="text-align:right;vertical-align:middle;">
                <div style="font-size:11px;color:#8a95a8;">Quellen: IS24 · Immowelt · Kleinanzeigen</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// EMAIL SENDEN
async function sendEmail(html, newCount) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY nicht gesetzt");
  const today = new Date().toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + RESEND_API_KEY },
    body: JSON.stringify({ from: EMAIL_FROM, to: EMAIL_TO, subject: "🏠 " + newCount + " neue Inserate in Hamm – " + today, html }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || "Resend Fehler");
  console.log("E-Mail gesendet: " + newCount + " neue Inserate");
  return result;
}

// HAUPTFUNKTION
async function runDailyBriefing() {
  const seenData = loadSeenListings();
  const todayListings = await fetchListings();
  const newListings = findNewListings(todayListings, seenData);
  const html = buildEmailHtml(newListings, todayListings.length);
  await sendEmail(html, newListings.length);
  saveListings(todayListings);
  return { total: todayListings.length, new: newListings.length };
}

// CRONJOB 07:00 UHR
cron.schedule("0 7 * * *", async () => {
  try { await runDailyBriefing(); }
  catch (err) { console.error("Cronjob Fehler:", err.message); }
}, { timezone: "Europe/Berlin" });

// TEST-ENDPUNKT
app.all("/api/send-briefing", async (req, res) => {
  try {
    const result = await runDailyBriefing();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Zoeger Agent laeuft auf Port " + PORT);
  console.log("Briefing: 07:00 Uhr Europe/Berlin → " + EMAIL_TO);
});
