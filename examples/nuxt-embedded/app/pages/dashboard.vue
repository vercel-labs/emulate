<script setup lang="ts">
const { data: session } = await useFetch("/api/session");
if (!session.value) {
  await navigateTo("/");
}

const { data: providers } = await useFetch("/api/providers");

const providerName = computed(
  () => providers.value?.find((p) => p.slug === session.value?.provider)?.name ?? session.value?.provider,
);

const otherProviders = computed(() => providers.value?.filter((p) => p.slug !== session.value?.provider) ?? []);

const initials = computed(() =>
  (session.value?.user.name ?? "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2),
);
</script>

<template>
  <div v-if="session" class="card">
    <h1>Dashboard</h1>
    <p class="subtitle">
      You're signed in via <span class="badge">{{ providerName }}</span>
    </p>

    <div class="profile">
      <div class="avatar">{{ initials }}</div>
      <div class="profile-text">
        <p class="name">{{ session.user.name }}</p>
        <p v-if="session.user.login" class="muted-line">@{{ session.user.login }}</p>
        <p class="muted-line">{{ session.user.email }}</p>
      </div>
    </div>

    <p class="label">Access Token</p>
    <code class="token">{{ session.accessToken }}</code>

    <a v-for="p in otherProviders" :key="p.slug" class="btn" :href="`/api/auth/${p.slug}`">
      Switch to {{ p.name }}
    </a>

    <form action="/api/auth/signout" method="post">
      <button type="submit" class="btn btn-danger">Sign Out</button>
    </form>
  </div>
</template>

<style scoped>
.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 0.4rem;
  background: #26262f;
  color: var(--fg);
  font-size: 0.8rem;
}

.profile {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 999px;
  background: #26262f;
  font-weight: 600;
}

.profile-text {
  min-width: 0;
}

.name {
  margin: 0;
  font-weight: 600;
  font-size: 1.05rem;
}

.muted-line {
  margin: 0.15rem 0 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.label {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--muted);
}

.token {
  display: block;
  padding: 0.75rem;
  margin-bottom: 1.25rem;
  border-radius: 0.5rem;
  background: #0b0b0f;
  border: 1px solid var(--border);
  font-size: 0.75rem;
  word-break: break-all;
}

form {
  margin-top: 0.75rem;
}
</style>
