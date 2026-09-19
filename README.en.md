# dsh-codex-connector

Teach **DeepSeek Harness (DSH)** how to use **Codex**.

Once installed, you can say something like *"draw me a hero image for the landing page"* — DSH hands the job to Codex, waits for it, and **the finished image appears inside your project folder**. DSH then tells you the exact path.

No commands to memorise. No window switching. No manually moving files around.

> 中文版：[README.md](./README.md)
> Developers and maintainers: see [`docs/`](./docs/).

---

## Contents

- [What it can do](#what-it-can-do)
- [Before you install](#before-you-install)
- [Installation](#installation)
- [How to use it](#how-to-use-it)
- [Where images go](#where-images-go)
- [DSH writes project notes for you](#dsh-writes-project-notes-for-you)
- [Teaching it new tricks](#teaching-it-new-tricks)
- [Common questions](#common-questions)
- [Safety and privacy](#safety-and-privacy)

---

## What it can do

Four capabilities are ready out of the box:

| You say | DSH does | Roughly how long |
|---|---|---|
| "Draw a photorealistic close-up of a gold pocket watch for the hero section" | Hands it to Codex; the image lands in your project's `assets/generated/` | 3–4 minutes |
| "Make me a set of three icons for this project" | Runs several images in one session, keeping the style as consistent as it can | ~3 minutes each |
| "Design a multi-tenant quota system" | Has Codex write a reviewable design document using a stronger model | 2–3 minutes |
| "Review my latest changes" | Codex reads your code (read-only) and lists problems by severity | 2–3 minutes |

Beyond those four, you can **teach it new tricks** — and DSH can teach itself (see [Teaching it new tricks](#teaching-it-new-tricks)).

### Things you should know up front

We'd rather tell you now than have you discover it later:

- **Every call takes at least 2 minutes.** That is Codex's reasoning time, not a hang. Don't use it for quick "run a command and show me the output" jobs.
- **Image size isn't always what you asked for.** Ask for 1024×1024 and you may get 1254×1254. That's how Codex's built-in image tool behaves, not a misconfiguration.
- **A multi-image set is only *approximately* consistent.** Corner radius and element proportions vary visibly between images. That's inherent to the tool, not a defect.
- **DSH waits for the whole call.** It does not move the work to the background. For several images, ask in batches rather than requesting ten at once.

---

## Before you install

| You need | How to check |
|---|---|
| **Codex installed and logged in** | Run `codex --version` in a terminal, then `codex login status`. Both should succeed |
| **A working DSH** | If you can open this interface, you're fine |
| **Node.js 20 or newer** | Run `node -v` |

> This project **installs no dependencies of its own**. That's deliberate: it loads reliably and can never fail because some small package went missing.

---

## Installation

Open a terminal **in this project's folder** and run:

```bash
# Step 1: see what would change (writes nothing)
node scripts/install.mjs --profile web

# Step 2: happy with the plan? write it
node scripts/install.mjs --profile web --apply

# Step 3: link the dependency
cd "$DSH_HOME/profiles/web" && pnpm install

# Step 4: restart DSH
```

Step 1 is a **dry run** — it only prints a list of intended changes. Nothing is touched until step 2.

The installer edits exactly two files, and it **backs each one up first**, restoring automatically if anything fails:

- `profiles/web/package.json` — adds a link to this project
- `profiles/web/cordis.patch.yml` — adds one plugin row

It **never** touches anything DSH ships with.

### Making the tools available to new sessions

The install above provides the tools **per session**. To have them in newly created sessions too, attach the row to a *preset*. Let the script copy a shipped preset and modify the copy:

```bash
node scripts/install.mjs --profile web --preset standard --apply
```

Then pick that preset when starting a new session.

### Confirming the install worked

```bash
cd "$DSH_HOME/profiles/web"
node <path-to-this-project>/scripts/verify-install.mjs
```

`INSTALL VERIFIED` means success. It checks four things the install itself cannot: that the package resolves, that its entry point is well-formed, that the config file is valid, and that the dependency is a local link.

### Uninstalling

```bash
node scripts/install.mjs --profile web --uninstall --apply
```

Also backs up first and restores on failure.

---

## How to use it

**Most of the time you don't need to learn anything. Just talk normally.**

DSH sees six tools, but realistically you only care about two:

| Tool | When you'd use it |
|---|---|
| `codex_do` | To have Codex do something. You just give it a sentence |
| `codex_status` | When something feels wrong, run this first for a health check |

The rest (`codex_capabilities`, `codex_skill_write`, `codex_skill_verify`, `codex_project`) exist for DSH's own use. You don't need to call them.

### Just ask in plain language

```
Draw me an image for the website landing page, dark blue tones, keep it simple
```

DSH works out that this means "generate an image", finds the matching capability, hands the job to Codex, and tells you where the file ended up.

### Being more specific

If you want several images or a particular size, say so:

```
Make me 3 icons at 1024x1024
```

### When it doesn't recognise your request

If DSH says *"no matching capability"*, **that's normal, not a failure**.

DSH deliberately refuses to guess — a wrong guess produces a result that *looks* successful but answers a different question, and it's hard to reproduce. You get two options:

1. Rephrase and try again (the wording may just not match the capability's keywords)
2. Have DSH pass the task straight through, or teach it a new capability

---

## Where images go

Finished images land in:

```
<your-project>/assets/generated/
```

Filenames are descriptive, like `hero-ai-coding-assistant.png` — not random strings.

DSH's reply includes the **full path**, and also a `recovered` field: if it's empty, Codex placed the file itself; if it isn't, the connector fetched it. Either way, you have the file.

> Existing files are never overwritten. On a name clash you get a versioned name: `hero.png` becomes `hero-v2.png`.

---

## DSH writes project notes for you

The first time you use Codex in a project, the connector creates a `.codex/` folder containing **project notes for Codex to read**:

```
<your-project>/
├── AGENTS.md              ← project conventions (never modified if it already exists)
└── .codex/
    ├── project/
    │   ├── PROJECT.md     ← stack, common commands, folder layout (auto-detected)
    │   ├── CAPABILITIES.md← which Codex capabilities this project can use
    │   └── HISTORY.md     ← a record of every run
    └── dsh/               ← explains what this folder is
```

**Why it helps:** Codex reads these before starting work, so you don't have to re-explain your project every time.

### Three promises

1. **Your existing `AGENTS.md` is never touched.** Not a single character. It's only created when absent.
2. **Your existing `.codex/config.toml` is never touched.** It's your file.
3. **A `.codex/` we didn't create is never written to.** DSH asks first.

### About "trusted projects"

Codex has a safety mechanism: **a project's execution-policy config stays inactive** until you mark that project as trusted in your own Codex configuration.

That sounds like a hassle, but the impact is smaller than it looks:

| What | Needs the trusted mark? |
|---|---|
| Project notes, stack, capability list | **No** — active immediately |
| Execution policy (sandbox level, model choice, etc.) | Yes |

So even with no marking at all, **Codex already knows your project background**. To enable execution policy, have DSH run:

```
codex_project { action: "grant-trust" }
```

It **asks your permission first** (this edits your global Codex config), backs up before writing, verifies afterwards, and restores on failure. Undo with `action: "revoke-trust"`.

> The connector **never** quietly edits your global config. If DSH reports there is no approval channel, it refuses to write and tells you how to add the entry by hand.

---

## Teaching it new tricks

This is the most interesting part: **you can teach it, and DSH can teach itself.**

### You ask, DSH teaches

```
Add a capability: turn a long article into an infographic
```

DSH will:

1. Check existing capabilities to confirm this doesn't exist yet
2. See whether Codex already has a suitable skill
3. Write a capability card
4. **Run one real call to verify it actually works**
5. Report back, including the evidence

Next time you ask for something similar, it just works.

### What a capability card looks like

An ordinary Markdown file inside your project at `.dsh-codex/capabilities/`. Open it in any editor:

```markdown
---
id: image.generate
title: Generate images
description: Use when AI-generated bitmap assets are needed.
triggers: [draw, generate image, illustration, artwork]
sandbox: workspace-write
artifacts:
  patterns: ["$CODEX_HOME/generated_images/**/*.png"]
  collectTo: assets/generated
inputs:
  - name: prompt
    required: true
---

Use the imagegen skill to produce: {{prompt}}
Afterwards copy the file into assets/generated/ with a descriptive name.
Finish by listing the absolute paths you actually wrote.
```

It's **human-readable**, **version-controllable**, and **debuggable by eye**.

Field reference, examples and common mistakes are in the developer docs under [`docs/`](./docs/).

### It won't rot into a junk pile

Self-extension sounds like it could run away, so there are guardrails:

- **Same name means revise, not duplicate.** No ten near-identical cards.
- **Editing an existing card requires reading it first.** No blind overwrites.
- **A new card must be verified to count.** Unverified cards are drafts and are not auto-selected.
- **Three consecutive failures retire it.** No repeatedly stepping on the same rake.
- **Every change leaves a trail.** Check `HISTORY.md` and `runs/`.

---

## Common questions

### I said "draw an image" and nothing happened

Run `codex_status` for a health check. If everything looks fine, the wording may not match the capability's keywords — try something more direct, like "draw me a picture" rather than "produce a visual asset".

### Every call takes several minutes

**That's expected.** On this network a call starts around 118–126 seconds, and images take longer. It isn't stuck.

### It says `timed out ... and was terminated`

The task exceeded its time limit and was stopped. **The result may be incomplete, and it is not reported as success** — deliberately, so you don't receive a partial result believing it's whole.

Fix: break the task into smaller pieces, or ask DSH for a longer timeout.

### The image succeeded but I can't find the file

Have DSH run `codex_status`, or look at the run record:

```
<your-project>/.dsh-codex/runs/<run-id>/result.json
```

It contains the full path information.

### The size is wrong

You asked for 1024×1024 and got 1254×1254 — that's Codex's built-in image tool. **Retrying won't change it.**

### `not supported when using Codex with a ChatGPT account`

A capability card names a model your account can't use. Have DSH clear that card's `model` field so it inherits Codex's default.

### After restarting, the plugin isn't listed

Usually a config-row formatting mistake — an easy one to make, and it fails silently. Have DSH run:

```bash
dsh --profile web --dump-config | Select-String 'tool-codex-connector'
```

If you see `patch: entry ... not found`, that's the cause. Re-running the installer fixes it.

### Every call runs to the timeout

**First rule out the network.** Have DSH run `codex doctor --summary` and look at the `reachability` and `websocket` lines. You can also test directly:

```powershell
Test-NetConnection chatgpt.com -Port 443
```

If that fails, the network can't reach Codex's servers — the connector can't help, and the fix is on the network side (proxy, VPN, firewall, or DNS).

### More problems

See [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) for detailed diagnostic steps.

---

## Safety and privacy

| Item | Detail |
|---|---|
| **Your keys stay yours** | Only necessary environment variables are passed to Codex. DSH's own API key is **not** handed over (51 unrelated variables filtered in measurement) |
| **Codex governs its own permissions** | The connector passes the permission level through; it does not change Codex's safety semantics |
| **Project files only, by default** | Enough to write images, going no further. Higher access must be explicitly requested per call |
| **Your global config is not edited** | Apart from the trusted-project marking you explicitly approve, the connector does not touch `~/.codex/config.toml` |
| **No stray files** | Output lands only in the project's `assets/generated/`, and never overwrites |

---

## Related documents

| Document | Audience |
|---|---|
| [`README.md`](./README.md) | Chinese user guide |
| [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) | Anyone changing the code or adding features |
| [`docs/DESIGN.md`](./docs/DESIGN.md) | Anyone interested in design trade-offs and measured evidence |
| [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) | Step-by-step diagnosis when something breaks |

---

## License

MIT
