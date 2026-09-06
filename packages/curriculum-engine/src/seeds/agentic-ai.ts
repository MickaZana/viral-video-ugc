// Curriculum Mode v2 — the "Agentic AI Simplified" seed.
//
// A CurriculumSeed fixes the course meta and the exact, ordered module list so a
// plan follows this known outline instead of an LLM inventing one. The architect
// (buildMockCurriculumPlan / generateCurriculumPlan in the orchestrator) reads
// module titles + goals straight from here; `id`/`orgId` never appear in a seed.

import type { CurriculumSeed } from "../schema.js";

/** 20-module beginner-to-intermediate track on building and shipping AI agents. */
export const SEED_AGENTIC_AI: CurriculumSeed = {
  course: {
    title: "Agentic AI Simplified",
    topic: "Agentic AI",
    audience: "Beginner-to-intermediate developers",
    startingKnowledge: [
      "Basic programming",
      "Basic Python or JavaScript",
      "Basic API understanding"
    ],
    endGoal: "Build and deploy production-grade AI agents",
    language: "en",
    moduleCount: 20,
    lessonsPerModule: 10,
    shortDurationSec: 60,
    longFormTargetMin: 15
  },
  modules: [
    {
      title: "What AI Agents Actually Are",
      goal: "Define what separates an agent from a plain LLM call and where agents genuinely help."
    },
    {
      title: "LLM Foundations for Agent Builders",
      goal: "Understand tokens, context windows, sampling, and cost as the constraints agent design lives inside."
    },
    {
      title: "Prompting for Agents",
      goal: "Write system and task prompts that steer reliable, inspectable agent behavior."
    },
    {
      title: "Tools and Function Calling",
      goal: "Give an agent typed tools and correctly handle the call-and-result loop."
    },
    {
      title: "Memory",
      goal: "Persist and recall short-term and long-term state across an agent's turns."
    },
    {
      title: "Retrieval and RAG",
      goal: "Ground an agent's answers in external documents with retrieval-augmented generation."
    },
    {
      title: "Planning",
      goal: "Have an agent decompose a goal into an ordered, revisable sequence of steps."
    },
    {
      title: "Agent Loops",
      goal: "Build the perceive-decide-act cycle that drives an autonomous agent to completion."
    },
    {
      title: "Multi-Agent Systems",
      goal: "Coordinate several specialized agents on one shared objective without chaos."
    },
    {
      title: "Model Context Protocol",
      goal: "Expose and consume tools and resources over MCP."
    },
    {
      title: "APIs and External Tools",
      goal: "Integrate third-party REST and SDK calls as agent tools safely and observably."
    },
    {
      title: "Browser and Computer-Using Agents",
      goal: "Drive a real browser and desktop UI from an agent."
    },
    {
      title: "Agent Evaluation",
      goal: "Measure agent quality with task suites, metrics, and regression checks."
    },
    {
      title: "Guardrails and Security",
      goal: "Constrain agent actions and defend against prompt injection and misuse."
    },
    {
      title: "Observability",
      goal: "Trace, log, and inspect agent runs to debug behavior in production."
    },
    {
      title: "Human-in-the-Loop Systems",
      goal: "Insert approval and correction steps where an agent should defer to a person."
    },
    {
      title: "Building an Agent Backend",
      goal: "Stand up the server, queue, and state layer an agent service needs."
    },
    {
      title: "Building an Agent UI",
      goal: "Build a chat and activity interface for interacting with an agent."
    },
    {
      title: "Production Deployment",
      goal: "Ship an agent with scaling, secrets, cost controls, and rollback."
    },
    {
      title: "Capstone Autonomous Application",
      goal: "Combine every prior module into one deployed, end-to-end autonomous application."
    }
  ]
};
