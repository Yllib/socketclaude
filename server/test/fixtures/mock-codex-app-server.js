const readline = require("node:readline");

const methods = [];
const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  methods.push(message.method);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "mock" } })}\n`);
    return;
  }
  if (message.method === "initialized") {
    process.stdout.write(`${JSON.stringify({
      method: "test/initialized_seen",
      params: { methods: [...methods] },
    })}\n`);
    return;
  }
  if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: message.params })}\n`);
  }
});
