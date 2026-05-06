import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KnowledgeBase, SearchResult } from "./store.js";
import { startHttpTransport } from "./http.js";
import { initEmbeddings, isReady, embed, cosineSimilarity } from "./embeddings.js";

const kb = new KnowledgeBase();

const KB_REMINDER =
  "[kb-server reminder] Antes de terminar el turno, verificar: ¿edité archivos no triviales?, ¿tomé una decisión técnica?, ¿resolví un bug?, ¿el usuario confirmó algo?, ¿descubrí info nueva sobre un proyecto? Si alguna es sí, llamar kb_ingest AHORA — no esperar al cierre de la conversación. Para evergreen (Proyecto:, Preferencias, Contexto Personal): kb_list primero para evitar duplicados.";

// --- Hybrid search helpers ---

async function searchSemantic(
  query: string,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  if (!isReady()) return [];

  const queryVec = await embed(query, "query");
  const allEmbeddings = kb.getAllEmbeddings();

  const scored = allEmbeddings.map((e) => ({
    id: e.doc_id,
    score: cosineSimilarity(queryVec, e.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function reciprocalRankFusion(
  ftsResults: Array<{ id: number }>,
  semResults: Array<{ id: number }>,
  k = 60
): number[] {
  const scores = new Map<number, number>();

  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  for (let i = 0; i < semResults.length; i++) {
    const id = semResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

async function searchHybrid(query: string, limit: number): Promise<SearchResult[]> {
  const ftsLimit = limit * 2;

  const [ftsResults, semResults] = await Promise.all([
    Promise.resolve(kb.search(query, ftsLimit)),
    searchSemantic(query, ftsLimit),
  ]);

  const rankedIds = reciprocalRankFusion(ftsResults, semResults);
  const topIds = rankedIds.slice(0, limit);

  // Build results preserving RRF order, using FTS data when available
  const ftsMap = new Map(ftsResults.map((r) => [r.id, r]));
  const results: SearchResult[] = [];

  for (const id of topIds) {
    const ftsHit = ftsMap.get(id);
    if (ftsHit) {
      results.push(ftsHit);
    } else {
      const doc = kb.read(id);
      if (doc) {
        results.push({
          id: doc.id,
          title: doc.title,
          snippet: doc.content.slice(0, 200),
          score: 0,
          tags: doc.tags,
          updated_at: doc.updated_at,
        });
      }
    }
  }

  return results;
}

// --- MCP Server ---

function createServer(): McpServer {
  const server = new McpServer({
    name: "kb-server",
    version: "1.0.0",
  });

  server.tool(
    "kb_search",
    "Busca en la knowledge base personal del usuario (memoria persistente entre conversaciones). DEBES llamar esta tool al inicio de toda conversación con dos queries: (1) 'preferencias de comunicación contexto personal' para cargar el perfil; (2) los temas principales del mensaje del usuario. Si un resultado parece relevante pero el snippet es incompleto, llamar kb_read con el ID. Usar el contexto encontrado de forma natural, sin mencionar que se buscó.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Max results (default 5)"),
    },
    async ({ query, limit }) => {
      console.log(`[kb_search] query="${query}" limit=${limit}`);
      try {
        const results = await searchHybrid(query, limit);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(results, null, 2) },
            { type: "text" as const, text: KB_REMINDER },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb_search] error: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "kb_ingest",
    "Guarda información en la knowledge base personal del usuario. NO esperar al cierre de la conversación — llamar en el momento en que se resuelve algo concreto. DEBES llamar esta tool cuando: (a) se llegó a una solución concreta (bug resuelto, decisión tomada, implementación completada); (b) el usuario dice 'guarda esto'/'registra esto'; (c) deploy exitoso de un cambio significativo; (d) bug en producción descubierto y resuelto — guardar inmediatamente con causa raíz; (e) decisión técnica con trade-offs evaluados, aunque parezca menor; (f) información nueva sobre un proyecto existente (cambio de stack, deadline, integrante); (g) conclusión sobre cómo hacer algo (workflow, proceso, configuración). Ante la duda, guardar — es más fácil borrar que perder contexto. Para documentos evergreen (contexto de proyecto, preferencias personales) incluir tag 'evergreen' Y llamar kb_list antes para verificar que no exista ya un doc con ese título (actualizar en lugar de duplicar). Verificación proactiva al final de CADA respuesta: ¿edité archivos?, ¿tomé una decisión?, ¿expliqué algo no obvio?, ¿el usuario confirmó algo? Si alguna es sí, llamar kb_ingest antes de terminar.",
    {
      title: z.string().describe("Document title"),
      content: z.string().describe("Document content"),
      tags: z.array(z.string()).optional().default([]).describe("Tags array"),
    },
    async ({ title, content, tags }) => {
      console.log(`[kb_ingest] title="${title}" tags=[${tags.join(", ")}]`);
      try {
        const id = kb.ingest(title, content, tags);

        // Fire-and-forget: generate embedding for the new/updated document
        if (isReady()) {
          embed(title + " " + content, "passage")
            .then((vec) => kb.saveEmbedding(id, vec))
            .then(() => console.log(`[embeddings] generated for doc ${id}`))
            .catch((err) =>
              console.error(`[embeddings] failed for doc ${id}: ${err instanceof Error ? err.message : String(err)}`)
            );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id, message: `Document "${title}" saved with id ${id}` }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb_ingest] error: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "kb_read",
    "Lee el contenido completo de un documento por ID. Llamar cuando kb_search devuelva un resultado relevante pero con snippet incompleto. Si el documento es evergreen y vas a actualizarlo con kb_ingest, lee primero para preservar contenido existente.",
    {
      id: z.coerce.number().describe("Document ID"),
    },
    async ({ id }) => {
      console.log(`[kb_read] id=${id}`);
      try {
        const doc = kb.read(id);
        if (!doc) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: `Document with id ${id} not found` }) },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(doc, null, 2) },
            { type: "text" as const, text: KB_REMINDER },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb_read] error: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "kb_list",
    "Lista documentos en la knowledge base, opcionalmente filtrados por prefijo de título. DEBES llamar esta tool antes de crear un documento evergreen (Proyecto:, Preferencias de Comunicación, Contexto Personal, etc.) para verificar si ya existe y actualizarlo en lugar de duplicar.",
    {
      prefix: z.string().optional().describe("Filter titles starting with this prefix"),
    },
    async ({ prefix }) => {
      console.log(`[kb_list] prefix=${prefix ?? "(all)"}`);
      try {
        const docs = kb.list(prefix);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(docs, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb_list] error: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "kb_delete",
    "Elimina un documento por ID. SOLO llamar cuando el usuario lo pide explícitamente ('borra esto', 'elimina ese documento'). Si crees que un documento es obsoleto o incorrecto, confirmar con el usuario ANTES de borrar — nunca borrar de forma autónoma.",
    {
      id: z.coerce.number().describe("Document ID to delete"),
    },
    async ({ id }) => {
      console.log(`[kb_delete] id=${id}`);
      try {
        const deleted = kb.delete(id);
        if (!deleted) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: `Document with id ${id} not found` }) },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ message: `Document ${id} deleted` }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb_delete] error: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Startup ---

async function main() {
  console.log("kb-server starting...");

  // Load embeddings model (graceful degradation if it fails)
  await initEmbeddings();

  // Migrate: generate embeddings for existing documents without them
  const missingIds = kb.getDocIdsWithoutEmbeddings();
  if (missingIds.length > 0) {
    console.log(`[migration] generating embeddings for ${missingIds.length} documents...`);
    for (const id of missingIds) {
      try {
        const doc = kb.read(id);
        if (doc) {
          const vec = await embed(doc.title + " " + doc.content, "passage");
          kb.saveEmbedding(id, vec);
        }
      } catch (err) {
        console.error(`[migration] failed for doc ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`[migration] done`);
  }

  startHttpTransport(createServer, kb);
}

main();
