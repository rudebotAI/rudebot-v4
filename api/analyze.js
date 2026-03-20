/* Vercel serverless function â proxies AI analysis requests to Anthropic API.
   This avoids CORS issues and keeps the API key server-side. */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in environment variables" });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt in request body" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system:
          "You are a ruthless quantitative stock trading analyst. Concise, aggressive, data-first. No disclaimers. Use numbered sections. Bold convictions only.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Anthropic API error:", response.status, errorText);
      return res.status(response.status).json({ error: `Anthropic API error: ${response.status}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "No analysis available.";
    return res.status(200).json({ text });
  } catch (err) {
    console.error("Analysis endpoint error:", err);
    return res.status(500).json({ error: err.message });
  }
}
