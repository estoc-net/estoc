import { createApp } from "vue";

import App from "./App.vue";
import { boot } from "./core/store.js";
import "./style.css";

createApp(App).mount("#app");

// The UI renders at once; the store decides which screen from what is on
// disk (and whether another tab already holds the vault).
void boot();
