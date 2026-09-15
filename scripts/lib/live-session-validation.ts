import type { AppController } from "../../src/app.js";

/** A restart starts a blank chat; saved tasks remain available only by explicit selection. */
export function freshSessionChecks(app: AppController) {
  const session = app.getSessionInfo(), board = app.snapshot(), history = app.chatHistory();
  return {
    freshChat: session.mode === "chat" && session.status === "idle" && !session.busy,
    noSelectedTask: app.storagePaths().task === undefined && app.listTasks().every(task => !task.selected),
    noChatHistory: !!history && history.messages.length === 0 && history.file === undefined,
    noPriorUsage: !!session.usage && Object.values(session.usage).every(value => value === 0),
    noResearchContext: [board.goals, board.facts, board.steps, board.findings, board.evidence, board.hints].every(items => items.length === 0),
  };
}
