# 🤖 MCP Client as a durable object

This example shows a working pattern using durable objects as an MCP client.

To start, install depdencies in `/` and `/external-mcp-server`

```
npm i
```

To start the client, run `npm run start`

To start the server, run `npx tsx external-mcp-server/mcp.ts`

Ask `Can you add 5 and 6`?

The client will make a call to the server, get the response and show it to the client.

## License

MIT
