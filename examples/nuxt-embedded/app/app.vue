<template>
  <div class="app">
    <NuxtPage />
  </div>
</template>

<style>
:root {
  --bg: #0b0b0f;
  --card: #16161d;
  --border: #26262f;
  --fg: #f4f4f5;
  --muted: #a1a1aa;
  --accent: #ffffff;
}

* {
  box-sizing: border-box;
}

html,
body,
#__nuxt {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family:
    ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

.app {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.card {
  width: 100%;
  max-width: 26rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 2rem;
}

.card h1 {
  margin: 0;
  font-size: 1.5rem;
  text-align: center;
}

.card .subtitle {
  margin: 0.5rem 0 1.5rem;
  color: var(--muted);
  text-align: center;
  font-size: 0.9rem;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  height: 2.75rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: transparent;
  color: var(--fg);
  font-size: 0.95rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.btn:hover {
  border-color: #3f3f4a;
}

.btn + .btn {
  margin-top: 0.75rem;
}

.btn-danger {
  border-color: #7f1d1d;
  color: #fca5a5;
}

.hint {
  margin-top: 1rem;
  font-size: 0.75rem;
  text-align: center;
  color: var(--muted);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
