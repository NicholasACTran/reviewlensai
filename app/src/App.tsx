import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { config } from "./config";
import { getJobClient } from "./api/jobClient.select";
import { UrlBoxPage } from "./routes/UrlBoxPage";
import { JobPage } from "./routes/JobPage";

// Lazy singleton — instantiated on first use, NOT at module top level, so importing App in a
// test (or running build) without VITE_USE_FAKE doesn't throw at import time.
let _client: ReturnType<typeof getJobClient> | null = null;
const client = () => (_client ??= getJobClient());

function Home() {
  const navigate = useNavigate();
  return <UrlBoxPage validatorUrl={config.validatorUrl} onSubmitted={(id) => navigate(`/job/${id}`)} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/job/:id" element={<JobPage client={client()} />} />
      </Routes>
    </BrowserRouter>
  );
}
