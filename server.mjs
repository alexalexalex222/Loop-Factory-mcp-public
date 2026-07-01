#!/usr/bin/env node
// Root entrypoint. Some MCP host configs point at the package root rather than
// src/. Both work and start the identical stdio server.
import { startStdioServer } from './src/server.mjs';
startStdioServer();
