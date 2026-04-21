---
name: aurelius-email
description: Drafts professional BenchAGI-branded outbound email as a Gmail draft, signed by Aurelius (or another named Bench agent) with a human-approver line and links to the public AI Transparency Audit Log. Use whenever the user asks to send, draft, compose, write, reply to, or follow up on any email on their behalf — especially to partners, customers, investors, cofounders (Jim, Jory), team members, or anyone outside the user. Also trigger on "as Aurelius", "on our behalf", "email them", "shoot a note", "write to", "ping <person>", or any variation implying outbound correspondence. Trigger even without the word "email" — "let them know", "follow up with X", "send a reminder" count when the medium is clearly written. Enforces our AI-transparency posture (every agent-drafted email gets a prepared-by/approved-by signature). Do NOT use for SMS, Slack DMs, in-app notifications, or internal system messages — those have their own channels.
---

# Aurelius Email (Tier D)

Draft outbound email with the canonical BenchAGI chrome and save as a Gmail draft for human review. The skill exists because every AI-prepared communication from Bench must visibly carry its provenance — who drafted it, who approved it, and how to see the audit trail.

**This is the Tier D version of this skill.** It requires no OpenClaw install — it uses only the Gmail MCP (via Claude's connector registry) plus this plugin's bundled template. If the Gmail connector isn't set up in the user's Claude Code, tell them to add it before proceeding.

## Finding the Gmail draft tool

The Gmail connector's draft tool is named `mcp__<connector-uuid>__create_draft`. Discover it by listing available tools that match `mcp__*__create_draft`. If multiple Gmail accounts are connected, ask the user which to use.

**Heads-up: connector tools are usually deferred.** If `create_draft` doesn't appear in your available tools, load its schema first via ToolSearch. Same for `search_threads` if you need to resolve recipients by name. You can't invoke a deferred tool without loading its schema.

## Workflow

### 1. Resolve recipients

If the user gives email addresses, use them. If they give names, search Gmail first. Known contacts:

- **Jim Johnson** — `jim@benchagi.com` (cofounder, coach)
- **Jory Allen** — `jory@benchagi.com` (ops)
- **Cory Shelton** — `cory@benchagi.com` (user / default approver)

Never invent addresses.

### 2. Draft the body

Terse, direct prose. Short paragraphs, concrete asks, bulleted lists for enumerable content. No "I hope this finds you well." No editorializing the AI-ness in the body — that's what the signature block is for.

### 3. Determine approver and timestamp

Approver defaults to **Cory Shelton**. Timestamp format: `MMM DD, YYYY, hh:mm AM/PM MDT` in `America/Denver`:

```
TZ=America/Denver date "+%b %d, %Y, %I:%M %p %Z"
```

The explicit `TZ=America/Denver` matters — without it, a machine in another zone stamps the wrong offset.

### 4. Render the template

Substitute `{{PLACEHOLDERS}}` in the templates below:
- `{{SUBJECT}}` — subject
- `{{BODY_HTML}}` — body as HTML (wrap paragraphs in `<p style="margin: 0 0 16px 0;">`, lists in `<ul style="margin: 0 0 16px 0; padding-left: 22px;">`)
- `{{BODY_TEXT}}` — body as plain text
- `{{PREPARED_BY}}` — usually `Aurelius`; can be `Cole`, `Ember`, `Piper`, `Sage`, `Bailey`, `Kestrel-Coder`
- `{{APPROVED_BY}}` — approver's full name
- `{{APPROVED_AT}}` — timestamp

### 5. Create the Gmail draft

Call the Gmail MCP's `create_draft` with both `body` (plain-text) and `htmlBody` (HTML). Both are required.

### 6. Report back

Return the draft ID and remind the user: "The draft is in your Gmail Drafts folder — review it there and hit Send. This MCP only creates drafts."

## Hard rules

- **Never send without a named human approver.**
- **Always emit both plain-text and HTML.**
- **Always include the AI Transparency link** (`https://benchagi.com/ai-transparency`).
- **Never invent recipient emails.**
- **Don't send via this skill** — draft only.
- **Don't re-draft silently** — point to the existing draft if one exists.

## Templates

### HTML template

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{SUBJECT}}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #F8FAFC; padding: 32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width: 640px; background-color: #FFFFFF; border-radius: 12px; border: 1px solid #E2E8F0; overflow: hidden;">
          <tr><td style="padding: 20px 32px; border-bottom: 3px solid #0F172A;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td><a href="https://benchagi.com?utm_source=aurelius-email&amp;utm_medium=email&amp;utm_campaign=aurelius-signature" style="text-decoration: none;"><span style="font-weight: 700; font-size: 20px; color: #0F172A; letter-spacing: -0.02em;">Bench<span style="color: #2563EB;">AGI</span></span></a></td>
              <td align="right" style="color: #64748B; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;">AI-prepared communication</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding: 32px; font-size: 15px; line-height: 1.65; color: #1a1a1a;">{{BODY_HTML}}</td></tr>
          <tr><td style="padding: 0 32px 32px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #E2E8F0; padding-top: 20px;"><tr>
              <td style="vertical-align: top; padding-right: 16px; width: 72px;">
                <img src="https://benchagi.com/images/aurelius.png" alt="{{PREPARED_BY}}" width="64" height="64" style="border-radius: 10px; display: block; border: 1px solid #E2E8F0;">
              </td>
              <td style="vertical-align: top;">
                <div style="font-weight: 600; font-size: 14px; color: #0F172A;">{{PREPARED_BY}}</div>
                <div style="font-size: 12px; color: #64748B; margin-bottom: 10px;">Bench Crew · BenchAGI</div>
                <div style="font-size: 12px; color: #334155; line-height: 1.6;">
                  <span style="color: #64748B;">Prepared by</span> {{PREPARED_BY}}<br>
                  <span style="color: #64748B;">Approved by</span> {{APPROVED_BY}} @ {{APPROVED_AT}}
                </div>
                <div style="font-size: 11px; color: #64748B; margin-top: 12px;">
                  <a href="https://benchagi.com/ai-transparency" style="color: #2563EB; text-decoration: none;">AI Transparency Audit Log</a>
                  &nbsp;·&nbsp;
                  <a href="https://benchagi.com?utm_source=aurelius-email&amp;utm_medium=email&amp;utm_campaign=aurelius-signature" style="color: #2563EB; text-decoration: none;">Get BenchAGI.com</a>
                </div>
              </td>
            </tr></table>
          </td></tr>
        </table>
        <div style="max-width: 640px; font-size: 11px; color: #94A3B8; padding: 16px 8px; text-align: center;">
          This message was prepared by a Bench AI agent under human approval. Every agent-drafted communication is logged in the <a href="https://benchagi.com/ai-transparency" style="color: #64748B;">AI Transparency Audit Log</a>.
        </div>
      </td></tr>
    </table>
  </body>
</html>
```

### Plain-text template

```
{{BODY_TEXT}}

—
Prepared by {{PREPARED_BY}} (Bench Crew, BenchAGI)
Approved by {{APPROVED_BY}} @ {{APPROVED_AT}}

AI Transparency Audit Log: https://benchagi.com/ai-transparency
Get BenchAGI.com: https://benchagi.com?utm_source=aurelius-email&utm_medium=email&utm_campaign=aurelius-signature
```

## Why this matters

The template is compliance posture, not decoration. When Bench AI drafts email to partners, customers, or the public, they must be able to tell at a glance that (a) AI prepared it, (b) a named human approved, (c) there's an audit trail. Don't simplify the chrome. Don't strip the UTM tag. Timestamps use America/Denver because that's the Bench team timezone.
