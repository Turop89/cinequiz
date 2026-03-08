import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CAT_MAP = {
  filme:       "Filme (Blockbuster, Klassiker, Regisseure, Schauspieler, Oscars)",
  serien:      "Serien (Netflix, HBO, Charaktere, Handlung, Schauspieler)",
  geschichte:  "Geschichte (Weltgeschichte, Jahreszahlen, Persönlichkeiten, Ereignisse)",
  wissen:      "Allgemeinwissen (Wissenschaft, Geografie, Natur, Sport, Technik)",
  musik:       "Musik (Bands, Alben, Künstler, Musikgeschichte, Charts)",
  mix:         "Mix aus Filmen, Serien, Geschichte, Allgemeinwissen und Musik",
};
const DIFF_MAP = {
  0: "leicht – für jeden verständlich, Allgemeinwissen",
  1: "mittel – für Quizfans, etwas kniffliger",
  2: "schwer – für Experten, sehr spezifisches Wissen",
};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { category, difficulty, exclude = [] } = req.body;

  const catLabel = CAT_MAP[category] || CAT_MAP.mix;
  const diffLabel = DIFF_MAP[difficulty ?? 1];
  const excludeHint = exclude.length
    ? `\nVermeide diese Fragen die bereits gestellt wurden: ${exclude.slice(-10).join(" | ")}`
    : "";

  const prompt = `Erstelle genau 1 Quiz-Frage auf Deutsch zum Thema: ${catLabel}.
Schwierigkeit: ${diffLabel}.${excludeHint}
Die Frage hat genau 4 Antwortmöglichkeiten, davon ist genau 1 korrekt.
Antworte NUR mit einem JSON-Objekt, kein Text davor oder danach, keine Markdown-Backticks.
Format: {"q":"Frage?","a":["A1","A2","A3","A4"],"c":0,"cat":"Kategoriename"}
wobei "c" der Index (0-3) der richtigen Antwort ist.
Die Frage muss faktisch korrekt sein!`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const raw   = message.content.map(b => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const q     = JSON.parse(clean);

    if (!q.q || !Array.isArray(q.a) || q.a.length !== 4 || typeof q.c !== "number")
      throw new Error("Ungültiges Format");

    res.status(200).json({ question: q });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler: " + e.message });
  }
}
