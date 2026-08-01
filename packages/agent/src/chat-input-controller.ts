export class ChatInputController {
  private value = "";
  private blockedReason: string | null = null;

  get draft(): string {
    return this.value;
  }

  get editable(): boolean {
    return true;
  }

  get submittable(): boolean {
    return this.blockedReason === null;
  }

  get submissionBlockedReason(): string | null {
    return this.blockedReason;
  }

  captureDraft(value: string): void {
    this.value = value;
  }

  setSubmissionBlocked(reason: string): void {
    this.blockedReason = reason;
  }

  allowSubmission(): void {
    this.blockedReason = null;
  }

  preserveDraft(): void {
    // The draft already lives independently from the active Session.
  }

  submit(options: { bypassBlock?: boolean } = {}): string | null {
    if (this.blockedReason !== null && options.bypassBlock !== true) return null;
    const submitted = this.value;
    this.value = "";
    return submitted;
  }
}
