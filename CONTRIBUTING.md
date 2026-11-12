# Contributing

Thanks for helping. Issues and pull requests are welcome, in English or Turkish. For a large change,
open an issue first so we can agree on the approach.

## How a change gets in

This repository is the public copy of Crewhall. Development happens in the maintainers' own
repository, and each release replaces the content here with one commit. So pull requests are not
merged here directly:

1. Open a pull request against the default branch. Keep it to one change, with its tests.
2. A maintainer reviews it here. Discussion and change requests happen on the pull request.
3. Once accepted, the change is applied in the maintainers' repository with you credited as
   `Co-authored-by` on the commit.
4. The pull request is closed with a note, and the change appears here in the next release commit.

Releases are not on a fixed schedule. If your change fixes something urgent, say so in the pull
request.

## Set up

Follow the Develop section of the [README](README.md).

## Rules for a change

- `pnpm turbo run typecheck lint test` must pass.
- Every feature comes with tests: Vitest, and a real Postgres for API integration tests.
- TypeScript is strict. No `any`, and external input is validated with zod.
- No hard-coded text in the interface. Every string lives in `@crewhall/i18n`, Turkish and English
  under the same key.
- No hard-coded organization names, logos or colors. They come from the branding settings.
- Every row in the data model carries `org_id`.
- Code, identifiers and comments are in English.
- Commit messages follow Conventional Commits, for example `fix(web): ...`.
- New dependencies must be MIT, Apache-2.0, BSD, ISC or PostgreSQL licensed.

## License of your contribution

Crewhall is licensed under Apache-2.0 with the Commons Clause, and Milvasoft may also offer it under
commercial terms. So that this stays possible, by submitting a contribution you agree that:

1. You wrote it, or you have the right to submit it under these terms.
2. You license it to Milvasoft and to recipients of Crewhall under the Apache License 2.0, without
   the Commons Clause condition.
3. Milvasoft may distribute it as part of Crewhall under the project's license and under other
   license terms, including commercial ones.

You keep the copyright in your contribution.
