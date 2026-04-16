export function asyncHandler(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response, next);
    } catch (error) {
      next(error);
    }
  };
}

export function sendBadRequest(response, message) {
  return response.status(400).json({ error: message });
}

export function normalizeQuery(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  response.status(error.statusCode || 500).json({
    error: error.message || "Internal Server Error",
  });
}
