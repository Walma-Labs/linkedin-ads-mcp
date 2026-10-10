#!/usr/bin/env node
// Local entrypoint — `linkedin-ads-mcp` runs the stdio server for Claude Code,
// Claude Desktop, Cursor and any stdio MCP client; `linkedin-ads-mcp auth`
// signs in once. Locally the draft tools are on (set LINKEDIN_ADS_DRAFT_TOOLS=0
// to hide them); they still refuse without the rw_ads scope.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { login } from "./auth.js";
import { createLinkedInAdsServer } from "./server.js";
import { createLinkedInClient } from "./linkedin.js";

if (process.argv[2] === "auth") {
  await login(process.argv[3]);
} else {
  const server = createLinkedInAdsServer(createLinkedInClient(), {
    draftTools: process.env.LINKEDIN_ADS_DRAFT_TOOLS !== "0",
    allowLocalFiles: true,
  });
  await server.connect(new StdioServerTransport());
}
