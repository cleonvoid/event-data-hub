# Cloud Run image for the Go/HTMX build.
#
# Build from the repository root:
#   docker build -t event-data-hub .
# Run locally against the compose database:
#   docker run --rm -p 8080:8080 --env-file .env \
#     -e DATABASE_URL='postgres://postgres:postgrespassword@host.docker.internal:5433/event_data_hub?sslmode=disable' \
#     event-data-hub

# ---- build stage ----------------------------------------------------------
FROM golang:1.24-bookworm AS build

WORKDIR /src

# Copy manifests first so dependency download is cached across source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
COPY internal ./internal

# CGO_ENABLED=0 produces a static binary, which is what lets the final stage be
# distroless/static. -trimpath keeps build paths out of the binary.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/event-data-hub .

# ---- runtime stage --------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=build /out/event-data-hub /app/event-data-hub
# Templates and migrations are read from disk at startup, so they ship with the
# image. Both are resolved relative to the working directory.
COPY templates ./templates
COPY migrations ./migrations

USER nonroot:nonroot

# Cloud Run injects PORT and ignores EXPOSE; this documents the default for
# local `docker run`.
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/event-data-hub"]
