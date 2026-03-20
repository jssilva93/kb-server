let pipeline: any = null;
let embeddingsReady = false;

export async function initEmbeddings(): Promise<void> {
  const start = Date.now();
  try {
    const { pipeline: createPipeline } = await import("@xenova/transformers");
    pipeline = await createPipeline("feature-extraction", "Xenova/multilingual-e5-small");
    embeddingsReady = true;
    console.log(`[embeddings] model loaded in ${Date.now() - start}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[embeddings] failed to load model: ${message}`);
  }
}

export function isReady(): boolean {
  return embeddingsReady;
}

export async function embed(text: string, prefix: "query" | "passage"): Promise<Float32Array> {
  if (!pipeline) throw new Error("Embeddings model not loaded");
  const input = prefix === "query" ? `query: ${text}` : `passage: ${text}`;
  const output = await pipeline(input, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
