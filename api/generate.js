import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { category, difficulty, count } = req.body;

  const catMap = {
    filme: "Filme (Blockbuster, Klassiker, Regisseure, Schauspieler, Oscars)",
    serien: "Serien (Netflix, HBO, Charaktere, Handlung, Schauspieler)",
    geschichte: "Geschichte (Weltgeschichte, Jahreszahlen, Persönlichkeiten, Ereignisse)",
    wissen: "Allgemeinwissen (Wissenschaft, Geografie, Natur, Sport, Technik)",
    musik: "Musik (Bands, Alben, Künstler, Musikgeschichte, Charts)",
    mix: "Mix aus Filmen, Serien, Geschichte, Allgemeinwissen und Musik",
  };

  const diffMap = {
    0: "leicht – für jeden verständlich, keine Expertenkenntnisse nötig",
    1: "mittel – für Quizfans, etwas kniffliger",
    2: "schwer – für Experten, sehr spezifisches Wissen nötig",
  };

  const prompt = `Erstelle genau ${count} Quiz-Fragen auf Deutsch zum Thema: ${catMap[category] || catMap.mix}.
Schwierigkeit: ${diffMap[difficulty] ?? diffMap[1]}.
Verteile die Schwierigkeiten gleichmäßig: ein Drittel leicht, ein Drittel mittel, ein Drittel schwer.
Jede Frage hat genau 4 Antwortmöglichkeiten, davon ist genau 1 korrekt.
Antworte NUR mit einem JSON-Array, kein Text davor oder danach, keine Markdown-Backticks.
Format: [{"q":"Frage?","a":["A1","A2","A3","A4"],"c":0,"cat":"Kategoriename"}]
wobei "c" der Index (0-3) der richtigen Antwort ist.
Alle Fragen müssen faktisch korrekt sein!`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content.map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const questions = JSON.parse(clean);
    const valid = questions
      .filter((q) => q.q && Array.isArray(q.a) && q.a.length === 4 && typeof q.c === "number")
      .slice(0, count);

    res.status(200).json({ questions: valid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Generieren: " + e.message });
  }
}
