---
name: terraform
description: "Use when the question is about Terraform or infrastructure code: 'where is this defined in Terraform', 'what does this change touch', 'waar staat de state', 'moet er een plan komen'."
---
# Terraform: find and explain, never apply

## When
The user asks where a resource, module, variable, provider or backend is defined, what a change touches, or which pipeline applies it.

## Steps
1. Find the Terraform repository: `repositories` in `team.yaml`, or `aihub repos list --filter terraform`. Not cloned: `aihub repos clone --name <repository>` (skill devops-repos).
2. Search with your own tools: `git grep -n 'resource "' `, `module "`, `variable "`, `backend "` and the name the user gave.
3. Answer in a few lines: module and resource, file and line, backend or state location, and which pipeline applies it (`aihub pipeline runs` shows the pipelines that ran for the branch).
4. A plan or apply is the user's own decision and runs only in the team pipeline, after an explicit yes: `aihub pipeline run --name <pipeline> --branch <branch>`, then `aihub pipeline follow`.

Example: "waar staat de workspace van DEV?" is `aihub repos clone --name infra`, `git grep -n 'dev' -- '*.tf'` and a three-line answer with file:line.

## What the CLI fills
Repository list, clone folder, pipeline names and run state. No Terraform command exists in `aihub`.

## If it fails
Repository or pipeline unknown: run `aihub doctor`, ask which one. Never invent file names, resource names or plan output.

Rules: never run `terraform plan` or `terraform apply` yourself, never touch state. Reading is free.
