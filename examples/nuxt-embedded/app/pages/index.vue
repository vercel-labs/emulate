<script setup lang="ts">
const { data: session } = await useFetch("/api/session");
if (session.value) {
  await navigateTo("/dashboard");
}

const { data: providers } = await useFetch("/api/providers");
</script>

<template>
  <div class="card">
    <h1>Sign In</h1>
    <p class="subtitle">Choose a provider to sign in with the embedded emulator</p>

    <a v-for="provider in providers" :key="provider.slug" class="btn" :href="`/api/auth/${provider.slug}`">
      Continue with {{ provider.name }}
    </a>

    <p class="hint">
      Emulators are embedded in this Nuxt app via <code>@emulators/adapter-nuxt</code>. No separate emulator
      process needed.
    </p>
  </div>
</template>
