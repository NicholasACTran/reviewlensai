import type { JobClient } from "./jobClient";
import { FakeJobClient } from "./fakeJobClient";
import { config } from "../config";

export function getJobClient(): JobClient {
  if (config.useFake) return new FakeJobClient();
  // Real client wired in Task 8:
  // return new AmplifyJobClient(generateClient().models);
  throw new Error("Amplify client not configured; set VITE_USE_FAKE=true for local dev.");
}
