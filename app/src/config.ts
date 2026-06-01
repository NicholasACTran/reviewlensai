export const config = {
  validatorUrl: import.meta.env.VITE_VALIDATOR_URL as string | undefined,
  useFake: import.meta.env.VITE_USE_FAKE === "true",
};
