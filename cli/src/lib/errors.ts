/** An error whose message is shown to the user as-is (one line, with the fix). */
export class AihubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AihubError";
  }
}
