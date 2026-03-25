import { Router, type IRouter } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { AnalyzeChartsBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/analyze-charts", async (req, res) => {
  const body = AnalyzeChartsBody.parse(req.body);

  const timeframeOrder = ["D1", "H4", "H1", "M15", "M5"];
  const sortedImages = body.images.sort(
    (a, b) => timeframeOrder.indexOf(a.timeframe) - timeframeOrder.indexOf(b.timeframe)
  );

  const imageContent = sortedImages.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: img.base64,
    },
  }));

  const textPrompt = `Você é um especialista em análise técnica de criptoativos com foco em SMC (Smart Money Concepts) e Price Action para scalping.

Analise os gráficos fornecidos (${sortedImages.map((i) => i.timeframe).join(", ")}) para ${body.symbol} e retorne uma análise JSON estruturada.

Preço atual via WebSocket: ${body.currentPrice}
Saldo da banca: ${body.balance || 187.5} USDT
Meta diária: ${body.dailyGoal || 175} USD

Para cada timeframe analise:
1. Leia o preço na régua direita do gráfico
2. Posição das médias EMA 9 e EMA 21 (acima/abaixo do preço)
3. Nível do RSI (número aproximado)
4. Padrão de candle (Engolfo, Martelo, Doji, Rejeição, etc)
5. Tendência (alta/baixa/lateral)

Regras de sincronia: Se o preço de entrada sugerido estiver a mais de 0.5% do preço atual (${body.currentPrice}), marque syncError como true.

Retorne APENAS um JSON válido com esta estrutura:
{
  "signal": "FORTE COMPRA" | "FORTE VENDA" | "COMPRA MODERADA" | "VENDA MODERADA" | "NEUTRO" | "AGUARDANDO",
  "direction": "LONG" | "SHORT" | "NEUTRO",
  "entryPrice": número,
  "stopLoss": número,
  "takeProfit": número,
  "leverage": número (1-20),
  "size": número,
  "riskPercent": número,
  "liquidationDistance": número (percentual),
  "syncError": boolean,
  "warning": string ou null,
  "verdict": "Aguarde fechamento de Candle de Força (Corpo Cheio) em [preço] para disparar a ordem" ou outra instrução precisa,
  "trendAnalysis": string descrevendo tendência macro,
  "rsiLevel": número (RSI no M15),
  "emaAlignment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "candlePattern": string,
  "timeframes": [
    {
      "timeframe": string,
      "trend": "ALTA" | "BAIXA" | "LATERAL",
      "price": número,
      "rsi": número ou null,
      "ema9": número ou null,
      "ema21": número ou null,
      "pattern": string ou null
    }
  ]
}

Hierarquia de decisão:
- D1/H4: define tendência macro
- H1: confirma direção intermediária
- M15/M5: identifica gatilho de entrada
- Só sinalize "FORTE" se todos os timeframes estiverem alinhados
- Se preço > EMA200 (1H): bloqueie SHORT (coloque warning sobre isso)
- Se preço < EMA200 (1H): bloqueie LONG (coloque warning sobre isso)`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            ...imageContent,
            { type: "text", text: textPrompt },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(500).json({ error: "No text response from AI" });
      return;
    }

    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(500).json({ error: "Could not parse AI response as JSON" });
      return;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    if (analysis.entryPrice && body.currentPrice) {
      const diff = Math.abs((analysis.entryPrice - body.currentPrice) / body.currentPrice) * 100;
      analysis.syncError = diff > 0.5;
    }

    res.json(analysis);
  } catch (err) {
    req.log.error({ err }, "Error analyzing charts");
    res.status(500).json({ error: "Erro ao analisar gráficos com IA" });
  }
});

export default router;
