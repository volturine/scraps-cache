# Connect an AI client

The operator must enable hosted MCP for your sync account first. Open Scraps Cache in the
browser you will use for authorization and link that browser to your sync account.

Hosted MCP lets this server decrypt requested notes in memory. The connected client receives
those notes and can search, read, create, update, and delete them. Its configured AI provider
may also receive their contents. Revoke access in Sync.

## Claude, Perplexity, ChatGPT, and Grok

Add a custom remote MCP connector with OAuth and this server URL:

```text
https://dev.scrapscache.com/api/mcp
```

Use automatic OAuth discovery and registration. No client secret is needed. Approve access
on the Scraps Cache consent page. For production, use your deployed production hostname.

Supported hosted callbacks follow the [Claude authentication documentation](https://claude.com/docs/connectors/building/authentication),
[Perplexity connector documentation](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors),
and [ChatGPT authentication documentation](https://developers.openai.com/plugins/build/auth).
Both Perplexity's standard and Enterprise callbacks are supported.
Perplexity's automatic registration sends all four callbacks together: the exact
`/rest/connections/oauth_callback` path on `www.perplexity.ai`, `www.perplexity.com`,
`enterprise.perplexity.ai`, and `enterprise.perplexity.com`, all over HTTPS.
All four exact URLs are accepted as the `perplexity` client; no manual client ID is needed.

## Hermes Agent (Nous Research)

Add this entry to your Hermes configuration:

```yaml
mcp_servers:
  scrapscache:
    url: 'https://dev.scrapscache.com/api/mcp'
    auth: oauth
```

Hermes uses dynamic registration with our server and opens your browser for consent. Complete
authorization on the same computer running Hermes: its callback returns to a local listener.
The consent page shows the local hostname and port. Only approve a flow you started yourself;
a loopback callback alone cannot authenticate which local app is listening.

Alternatively, copy a token from Sync → AI access → Manual setup and configure an
`Authorization: Bearer` header using a secret environment variable. Never put a token in the
server URL. See the [Hermes MCP configuration reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference).
