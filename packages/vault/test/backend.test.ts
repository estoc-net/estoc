import { MemoryBackend } from "../src/index.js";
import { backendSuite } from "./backend-suite.js";

backendSuite("memory", async () => new MemoryBackend());
