import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
document.documentElement.dataset.surface =
  location.protocol === "chrome-extension:" ? "popup" : "preview";
createApp(App).mount("#app");
