import http from "node:http";

function buildInjectResponse(response, body) {
  return {
    statusCode: response.status,
    body,
    json() {
      return body ? JSON.parse(body) : null;
    },
  };
}

export function attachTestCompatibility(app) {
  app.inject = async ({ method = "GET", url, payload, headers = {} }) => {
    const server = http.createServer(app);
    await new Promise((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });

    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const body = await response.text();
      return buildInjectResponse(response, body);
    } finally {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  };

  app.close = async () => {};
}
