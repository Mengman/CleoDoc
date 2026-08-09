import { helpText } from "../help.js";

export function runHelpCommand(output: NodeJS.WritableStream): void {
  output.write(helpText);
}
