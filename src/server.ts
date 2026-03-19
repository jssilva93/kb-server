import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KnowledgeBase } from "./store.js";
import { startHttpTransport } from "./http.js";

const kb = new KnowledgeBase();

function createServer(): McpServer {
  const server = new McpServer({
    name: "kb-server",
    version: "1.0.0",
  });

  server.tool(
    "kb_search",
    "Busca en la knowledge base personal. Usa esto al inicio de conversaciones técnicas para recuperar contexto relevante sobre proyectos, bugs resueltos, decisiones de arquitectura o preferencias de trabajo.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Max results (default 5)"),
    },
    async ({ query, limit }) => {
      console.log(`[kb_search] query="${query}" limit=${limit}`);
      try {
        const results = kb.search(query, limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
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
    "Guarda información en la knowledge base. Usa esto al cerrar conversaciones donde se resolvió algo concreto. Para documentos evergreen (contexto de proyecto, preferencias personales) incluye el tag 'evergreen' para actualizar en lugar de crear nuevo.",
    {
      title: z.string().describe("Document title"),
      content: z.string().describe("Document content"),
      tags: z.array(z.string()).optional().default([]).describe("Tags array"),
    },
    async ({ title, content, tags }) => {
      console.log(`[kb_ingest] title="${title}" tags=[${tags.join(", ")}]`);
      try {
        const id = kb.ingest(title, content, tags);
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
    "Lee el contenido completo de un documento por ID. Usa esto cuando kb_search devuelva un resultado relevante y necesites el contenido completo.",
    {
      id: z.number().describe("Document ID"),
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
          content: [{ type: "text" as const, text: JSON.stringify(doc, null, 2) }],
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
    "Lista documentos disponibles en la knowledge base. Usa esto para explorar qué contexto existe sobre un proyecto o área específica.",
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

  return server;
}

console.log("kb-server starting...");
startHttpTransport(createServer, kb);
