# Selector resilience (load when writing specs)

Flaky selectors are the #1 cause of brittle web tests. Prefer user-facing, semantic locators.

**Preference order:**
1. `page.getByRole('button', { name: 'Sign in' })` — accessibility role + name (most resilient)
2. `page.getByLabel('Email')`, `page.getByPlaceholder(...)`, `page.getByText(...)`
3. `page.getByTestId('...')` — if the app ships `data-testid`
4. CSS/attribute (`input[type=email]`) — okay for stable structural attrs
5. ❌ Avoid: deep CSS chains, nth-child, auto-generated class hashes, XPath by position

**Why role/label first:** they track what the *user* perceives, survive restyling/refactors, and double as an accessibility check (if `getByRole` can't find it, a screen reader can't either).

**Waiting:** never `waitForTimeout` as a sync mechanism — assert on the element/state with
web-first assertions (`await expect(locator).toBeVisible()`); Playwright auto-retries. Use a
short fixed wait only for genuinely async side-effects (e.g. an auth round-trip) you can't observe.

**React controlled inputs:** use `fill()` / `type()`, never `el.value = ...` (won't fire onChange).
