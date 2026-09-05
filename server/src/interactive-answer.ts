/** Shared lifecycle for SDK callbacks that wait for a phone response. */
export interface PendingInteractiveAnswer {
  questionId: string;
  questionData?: any;
  resolve: (answers: Record<string, string>) => void;
  cancel?: () => void;
}

export function waitForInteractiveAnswer(
  pending: Map<string, PendingInteractiveAnswer>,
  questionId: string,
  questionData: any,
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answers: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      pending.delete(questionId);
      if (answers === null) onCancel();
      resolve(answers);
    };
    const cancel = () => finish(null);
    pending.set(questionId, { questionId, questionData, resolve: finish, cancel });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
