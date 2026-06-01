import { generateClient } from "aws-amplify/data";
import type { JobClient } from "./jobClient";
import { FakeJobClient } from "./fakeJobClient";
import { AmplifyJobClient } from "./amplifyJobClient";
import { config } from "../config";

export function getJobClient(): JobClient {
  if (config.useFake) return new FakeJobClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AmplifyJobClient(generateClient().models as any); // called lazily by App (non-fake path only)
}
