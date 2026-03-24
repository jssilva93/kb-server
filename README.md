# kb-server

MCP server for a personal knowledge base with hybrid search (FTS5 + semantic). Built with SQLite FTS5, vector embeddings via [multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small), and the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) (MCP spec 2025-03-26).

## Stack

- Node.js 20 + TypeScript (strict mode)
- SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — synchronous, no ORM
- Hybrid search: FTS5 (BM25) + semantic embeddings fused via Reciprocal Rank Fusion
- [@xenova/transformers](https://github.com/xenova/transformers.js) — multilingual-e5-small for vector embeddings (384 dims, multilingual)
- Express for HTTP transport
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for MCP protocol
- OAuth 2.0 Authorization Code flow for authentication

## MCP Tools

| Tool | Description |
|---|---|
| `kb_search` | Hybrid search (FTS5 + semantic). Keyword matches and conceptual similarity fused via RRF. |
| `kb_ingest` | Save a document. Tag with `"evergreen"` to upsert by title instead of creating duplicates. |
| `kb_read` | Read full document content by ID. |
| `kb_list` | List documents, optionally filtered by title prefix. |
| `kb_delete` | Delete a document by ID. |

## Setup

```bash
git clone https://github.com/jssilva93/kb-server.git
cd kb-server
npm install
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
PORT=3000
OAUTH_CLIENT_ID=claude-ai
OAUTH_CLIENT_SECRET=<generate with: openssl rand -hex 32>
```

If `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` are not set, OAuth is disabled and all endpoints are open (useful for local development).

### Run

```bash
# Production
npm start

# Development (with ts-node)
npm run dev
```

Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","documents":0}
```

## OAuth 2.0

When OAuth is enabled, the server exposes:

| Endpoint | Method | Description |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | OAuth discovery metadata |
| `/oauth/authorize` | GET | Authorization endpoint — generates code, redirects |
| `/oauth/token` | POST | Token endpoint — exchanges code for access token |

All `/mcp` endpoints require a valid `Authorization: Bearer <token>` header.

Auth codes and access tokens are persisted in SQLite, so they survive server restarts.

## Connecting to Claude.ai

1. Go to **Settings → Integrations → Add Integration**
2. Set the URL to `https://your-domain.com/mcp`
3. Enter your `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`
4. Claude.ai discovers the OAuth endpoints automatically via `/.well-known/oauth-authorization-server`

## Connecting to Claude Code

```bash
claude mcp add --transport http \
  --client-id <your-client-id> \
  --client-secret \
  --callback-port 8080 \
  kb-server https://your-domain.com/mcp
```

You'll be prompted for the client secret. Then authenticate via `/mcp` in Claude Code.

## Production deployment

The server is designed to run behind a reverse proxy (nginx) with TLS. Key nginx settings for SSE support:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Required for SSE streams
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
}
```

### Process manager

```bash
pm2 start dist/server.js --name kb-server
pm2 startup    # auto-start on reboot
pm2 save
```

## Database

SQLite file is stored at `./data/kb.sqlite` (created automatically on first run).

### Tables

- **meta** — document metadata (id, title, tags, timestamps)
- **documents** — FTS5 virtual table (title, content, tags) for full-text search
- **embeddings** — vector embeddings (doc_id, BLOB) for semantic search, cascades on delete
- **oauth_codes** — authorization codes (auto-cleaned)
- **oauth_tokens** — access tokens (auto-cleaned)

### Backup

```bash
# Stop server before copying the SQLite file
pm2 stop kb-server
cp data/kb.sqlite /path/to/backup/kb-$(date +%Y%m%d).sqlite
pm2 start kb-server
```

## Project structure

```
kb-server/
  src/
    server.ts      # MCP server factory, hybrid search, startup migration
    store.ts       # KnowledgeBase class — SQLite + FTS5 + embeddings + OAuth storage
    embeddings.ts  # Embedding pipeline (multilingual-e5-small), cosine similarity
    http.ts        # Express server — Streamable HTTP transport + OAuth endpoints
  .env.example
  package.json
  tsconfig.json
```

## System prompt for LLMs / Prompt de sistema para LLMs

Instructions for any LLM client (Claude, etc.) to use the KB effectively. Add this to your system prompt or CLAUDE.md.

Instrucciones para cualquier cliente LLM (Claude, etc.) para usar la KB efectivamente. Agregar al system prompt o CLAUDE.md.

<details>
<summary>English</summary>

```markdown
# Personal knowledge base (tools: kb_search, kb_ingest, kb_read, kb_list, kb_delete)

## At the start of every conversation:

- Call kb_search with "communication preferences personal context" to load the user's profile
- Call kb_search with the main topics from the user's message
- If a result seems relevant but incomplete, call kb_read with the corresponding ID to get the full document
- Use the context found naturally, without mentioning that a search was performed

## Save to the KB when:

- A concrete solution was reached (bug resolved, decision made, implementation completed)
- The user says "save this", "record this" or similar
- A new project context was defined
- A successful deploy of a significant change was made (new feature, production fix, infra change)
- A production bug was discovered and resolved — save immediately with root cause and solution
- A technical decision with evaluated trade-offs was made, even if it seems minor
- Do not wait until the end of the conversation — save the moment something concrete is resolved
- When in doubt, save. It's easier to delete an unhelpful document than to lose valuable context

Before creating an evergreen document, call kb_list to check if one with that title already exists and update it instead of creating a duplicate.

## Document formats by type:

### Bugs and solutions → new document

- title: "[project] short problem description"
- tags: [project, technology, "bug", "resolved"]
- content: ## Problem / ## Root cause / ## Solution / ## Relevant code

### Architecture decisions → new document

- title: "[project] Decision: what was decided"
- tags: [project, "decision", "architecture"]
- content: ## Context / ## Options evaluated / ## Decision / ## Reason

### Project context → update existing evergreen document

- title: "Project: [name]"
- tags: [project, "context", "evergreen"]

### Work preferences → update existing evergreen document

- title: "Communication Preferences"
- tags: ["personal", "preferences", "evergreen"]

### Personal context → update existing evergreen document

- title: "Personal Context — [Name]"
- tags: ["personal", "context", "evergreen"]

### Exploratory ideas → new document

- title: "[area] Idea: description"
- tags: [area, "idea"]

## Delete from the KB when:

- The user explicitly asks ("delete this", "remove that document")
- A document is clearly obsolete or incorrect (confirm with the user before deleting)
- Use kb_delete with the document ID

## Do not save:

- Conversations without a concrete conclusion
- General questions without personal context
- Content that already exists without new changes
```

</details>

<details>
<summary>Español</summary>

```markdown
# Base de conocimiento personal (tools: kb_search, kb_ingest, kb_read, kb_list, kb_delete)

## Al inicio de cada conversación:

- Llamar kb_search con "preferencias de comunicación contexto personal" para cargar el perfil del usuario
- Llamar kb_search con los temas principales del mensaje del usuario
- Si el resultado parece relevante pero incompleto, llamar kb_read con el ID correspondiente para obtener el documento completo
- Usar el contexto encontrado de forma natural, sin mencionar que se buscó

## Guardar en la KB cuando:

- Se llegó a una solución concreta (bug resuelto, decisión tomada, implementación completada)
- El usuario dice "guarda esto", "registra esto" o similar
- Se definió el contexto de un proyecto nuevo
- Se hizo deploy exitoso de un cambio significativo (nueva feature, fix de producción, cambio de infra)
- Se descubrió y resolvió un bug en producción — guardar inmediatamente con causa raíz y solución
- Se tomó una decisión técnica con trade-offs evaluados, aunque parezca menor
- No esperar al cierre de la conversación — guardar en el momento en que se resuelve algo concreto
- Ante la duda, guardar. Es más fácil borrar un documento que no sirve que perder contexto valioso

Antes de crear un documento evergreen, llamar kb_list para verificar si ya existe uno con ese título y actualizarlo en lugar de crear un duplicado.

## Formatos por tipo de documento:

### Bugs y soluciones → documento nuevo

- title: "[proyecto] descripción corta del problema"
- tags: [proyecto, tecnología, "bug", "resuelto"]
- contenido: ## Problema / ## Causa raíz / ## Solución / ## Código relevante

### Decisiones de arquitectura → documento nuevo

- title: "[proyecto] Decisión: qué se decidió"
- tags: [proyecto, "decisión", "arquitectura"]
- contenido: ## Contexto / ## Opciones evaluadas / ## Decisión / ## Razón

### Contexto de proyecto → actualizar documento evergreen existente

- title: "Proyecto: [nombre]"
- tags: [proyecto, "contexto", "evergreen"]

### Preferencias de trabajo → actualizar documento evergreen existente

- title: "Preferencias de Comunicación"
- tags: ["personal", "preferencias", "evergreen"]

### Contexto personal → actualizar documento evergreen existente

- title: "Contexto Personal — [Nombre]"
- tags: ["personal", "contexto", "evergreen"]

### Ideas exploratorias → documento nuevo

- title: "[área] Idea: descripción"
- tags: [área, "idea"]

## Borrar de la KB cuando:

- El usuario lo pide explícitamente ("borra esto", "elimina ese documento")
- Un documento es claramente obsoleto o incorrecto (confirmar con el usuario antes de borrar)
- Usar kb_delete con el ID del documento

## No guardar:

- Conversaciones sin conclusión concreta
- Preguntas generales sin contexto personal
- Contenido que ya existe sin cambios nuevos
```

</details>

## How hybrid search works

1. **FTS5** finds keyword matches using BM25 ranking
2. **Semantic search** embeds the query with multilingual-e5-small and compares against stored document vectors via cosine similarity
3. **Reciprocal Rank Fusion** (k=60) merges both ranked lists into a single result set
4. Embeddings are generated automatically on ingest and backfilled at startup for existing documents
5. If the embedding model fails to load, search degrades gracefully to FTS5-only
