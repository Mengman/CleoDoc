export function runVersionCommand(output: NodeJS.WritableStream): void {
  output.write("0.1.0\n");
}
