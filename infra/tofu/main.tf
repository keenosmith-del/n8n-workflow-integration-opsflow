terraform {
  required_version = ">= 1.6.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.6"
    }
  }
}
provider "docker" {
  host = var.docker_host
}
variable "docker_host" {
  description = "Docker Engine socket; set to unix:///Users/YOU/.docker/run/docker.sock on macOS"
  type        = string
  default     = "unix:///var/run/docker.sock"
}
variable "environment" {
  type    = string
  default = "staging"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Choose staging or production, distinct from local Compose."
  }
}
resource "docker_network" "opsflow" {
  name = "opsflow-${var.environment}"
}
resource "docker_volume" "postgres" {
  name = "opsflow-${var.environment}-postgres"
}
resource "docker_volume" "redis" {
  name = "opsflow-${var.environment}-redis"
}
resource "docker_volume" "rabbit" {
  name = "opsflow-${var.environment}-rabbit"
}
output "deployment_resources" {
  value = {
    network = docker_network.opsflow.name
    postgres_volume = docker_volume.postgres.name
    redis_volume = docker_volume.redis.name
    rabbit_volume = docker_volume.rabbit.name
  }
}
