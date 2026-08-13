# Dockerfile for Event Data Hub (Cloud Run deployment)
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY go.mod go.sum ./
RUN go mod download || true

# Copy source code
COPY . .

# Build statically linked binary
RUN CGO_ENABLED=0 GOOS=linux go build -v -o event-data-hub .

# Final minimal distroless container
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /

COPY --from=builder /app/event-data-hub /event-data-hub
COPY --from=builder /app/templates /templates
COPY --from=builder /app/migrations /migrations

EXPOSE 3000
USER nonroot:nonroot

ENTRYPOINT ["/event-data-hub"]
