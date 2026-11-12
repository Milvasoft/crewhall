# Crewhall

[Türkçe](README.tr.md)

Crewhall is a self-hosted workspace for a team: quick access, Drive, chat, pages, boards, drawings,
meetings, a zero-knowledge vault and a documentation portal in one place. Everything runs on your
own server, and your organization's name, logo and colors come from the admin panel.

## Features

- **Home:** quick access cards, links, notes and announcements.
- **Drive:** folders, sharing, versions, trash, previews and Office editing through an optional
  separate service.
- **Chat:** channels, direct messages, threads, reactions, calls and bots.
- **Pages and boards:** a wiki and task boards with real-time collaboration.
- **Drawings:** a shared whiteboard.
- **Meetings:** video meetings on LiveKit.
- **Vault:** zero-knowledge password sharing. The server never sees decrypted data.
- **Portal:** a public documentation and blog site managed from the workspace.
- **Identity:** email and password, TOTP, passkeys, OIDC and directory sign-in.
- **Plugins:** an SDK for tabs, cards, commands and tools. See [packages/plugin-sdk](packages/plugin-sdk).
- **MCP:** connect AI assistants to the workspace with per-connection scopes.
- **Clients:** web and a Windows and macOS desktop app. The interface is in Turkish and English.

## Run it on a server

Crewhall runs on one Linux server with Docker Compose. The full guide, currently in Turkish, is in
[docs/kurulum.md](docs/kurulum.md).

```bash
git clone <repository-url> crewhall && cd crewhall
cp docker/.env.example docker/.env
```

Fill in `docker/.env` as the guide describes, then start the stack from `docker/compose.yml`.

## Develop

You need Node 22, Docker and pnpm (`corepack enable`).

```bash
tools/dev-up/dev-up.sh
```

This starts Postgres, S3 storage and a mail catcher, creates the local `.env` files, seeds a sample
organization and runs the API, the collaboration server and the web app. `tools/dev-up/dev-up.ps1`
does the same on Windows.

Before you send a change, this must pass:

```bash
pnpm turbo run typecheck lint test
```

## Stack

| Area      | Technology                                            |
| --------- | ----------------------------------------------------- |
| API       | Node 22, Hono, Drizzle, PostgreSQL 17, better-auth    |
| Real time | `ws`, Hocuspocus and Yjs                              |
| Web       | React 19, Vite, TanStack Router and Query, Tailwind 4 |
| Desktop   | Electron                                              |
| Portal    | Next.js                                               |
| Storage   | Any S3-compatible service, SeaweedFS by default       |
| Jobs      | pg-boss                                               |
| Packaging | pnpm and Turborepo; Docker Compose for deployment     |

## Not included

The central plugin marketplace service and the mobile app are not part of this repository. Plugins
can still be installed from your own server, and `MARKETPLACE_URL` sets which marketplace the
backend talks to.

## License

Crewhall is **source-available**: the code is public and free to use, but it may not be sold. It is
licensed under the Apache License 2.0 with the [Commons Clause](https://commonsclause.com). Because
of that condition it is not "open source" as the Open Source Initiative defines the term. The
[LICENSE](LICENSE) file is what counts; this table is a summary.

| You may                                                    | You may not                                          |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| Use it for free, alone or inside a company of any size     | Sell Crewhall or a product built substantially on it |
| Run it on your own servers for your own people             | Offer it to others as a paid hosted service          |
| Read, change and fork the code                             | Charge for consulting or support related to Crewhall |
| Share your copy with others, with the license notices kept |                                                      |

`packages/plugin-sdk` and `apps/plugin-hello` are MIT licensed, so you can build and sell plugins
freely. The Crewhall and Milvasoft names and logos are not licensed; a fork that is distributed
should use its own name and logo.

For a commercial license, contact [Milvasoft](https://www.milvasoft.com).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
