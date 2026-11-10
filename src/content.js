export const site = {
  origin: "https://cashel.dev",
  name: "Cashel Fitzgerald",
  title: "Cashel Fitzgerald — Co-founder & CTO at Zomma",
  description: "Cashel Fitzgerald is the co-founder and CTO of Zomma, building computer-use agents for financial operations. Explore his machine learning research and projects.",
  bio: "Cashel Fitzgerald is the co-founder and CTO of Zomma, where he builds computer-use agents for financial operations. Based in San Francisco, he works on machine learning systems that connect models with real software and workflows.",
};

export const articles = [
  {
    path: "/about/",
    title: "About Cashel Fitzgerald",
    category: "ABOUT",
    description: "About Cashel Fitzgerald, co-founder and CTO of Zomma: computer-use agents, machine learning, Cornell CS, UT Austin ECE, and selected projects.",
    summary: site.bio,
    sections: [
      {
        title: "What I work on",
        paragraphs: [
          "At Zomma, I build computer-use agents for the financial back office. These agents interact with the screens and tools people already use. My work brings together machine learning and the engineering needed to make models useful in real workflows.",
          "My independent projects explore reinforcement learning, visual speech recognition, and language models. This site brings those projects together with their source material and an interactive look inside a running diffusion language model."
        ]
      },
      {
        title: "Background",
        paragraphs: ["My background includes computer science at Cornell, electrical and computer engineering at UT Austin, and previous work at Modern Intelligence. I am based in San Francisco, California."]
      },
      {
        title: "Selected work",
        paragraphs: ["Marvin makes token states and measured model activations visible during generation. My speaker-adaptation research with Jihyun Kim investigates how a lip-reading model can adapt to a video without test-time gradient updates. Minecraft RL explores agent training in a custom combat environment."],
        links: [
          { label: "Marvin: inside a diffusion language model", href: "/projects/marvin/" },
          { label: "Support-conditioned LoRA for speaker adaptation", href: "/projects/speaker-adaptation/" },
          { label: "Minecraft reinforcement learning", href: "/projects/minecraft-rl/" }
        ]
      },
      {
        title: "Find me elsewhere",
        paragraphs: ["For current company work, visit Zomma. My GitHub contains project code, and LinkedIn has my professional profile."],
        links: [
          { label: "Zomma", href: "https://www.zommalabs.com/" },
          { label: "Cashel Fitzgerald on GitHub", href: "https://github.com/CashelF" },
          { label: "Cashel Fitzgerald on LinkedIn", href: "https://www.linkedin.com/in/cashelfitzgerald" }
        ]
      }
    ]
  },
  {
    path: "/projects/marvin/",
    title: "Marvin: inside a diffusion language model",
    category: "LANGUAGE MODELS · INTERACTIVE SYSTEMS",
    description: "How Cashel Fitzgerald built Marvin: a live diffusion language model with token-by-token state inspection, measured hidden activations, and an interactive architecture view.",
    summary: "Marvin is an interactive diffusion language model demo built by Cashel Fitzgerald. It shows real token states and measured hidden activations while a response is generated, connecting the model’s output to an explorable view of its architecture.",
    sections: [
      {
        title: "What I built",
        paragraphs: [
          "I built the website integration, streaming interface, and instrumented backend that connect a running model to the visualization. The underlying checkpoint is dllm-hub’s Qwen3-0.6B diffusion model; Marvin is an application and inspection interface around that model.",
          "The chat and brain view share one response stream. A timeline lets visitors inspect captured diffusion steps, including the token IDs and tokenizer pieces at each step. The backend serves one generation at a time with two waiting spots, and cancels work when a visitor leaves the active interface."
        ],
        links: [{ label: "Try Marvin on the homepage", href: "/#brain" }]
      },
      {
        title: "What the visualization measures",
        paragraphs: [
          "The architecture view connects token embeddings, 28 transformer blocks, final normalization, and the language-model output head. Within a block, 16 query heads share eight key/value heads, followed by the feed-forward network and residual connections.",
          "Color reflects measurements from the current forward pass: residual RMS, attention-head measurements, and 32 sampled MLP channels. The connections describe model structure; they are not measured attention weights. When telemetry is unavailable, the interface shows an unlit architecture and an explicit connection state."
        ]
      },
      {
        title: "Results and limitations",
        paragraphs: [
          "A local CPU comparison on September 5, 2026 measured 6.53, 11.19, and 11.07 seconds for three prompts using the current 0.6B model with 96 diffusion steps and live telemetry. It used two physical cores of an AMD Ryzen Threadripper 9970X, batch size one, and one measured sample per prompt.",
          "Those timings exclude model loading, HTTP latency, and queue time. They describe a local latency probe, not the Hugging Face deployment or a statistical quality evaluation. The small model can repeat words or give inaccurate explanations; its responses should not be treated as an authoritative biography or technical reference."
        ]
      },
      {
        title: "Code, model, and measurements",
        paragraphs: ["The source includes the instrumented runtime, streaming code, and the exact benchmark settings and outputs."],
        links: [
          { label: "Marvin source and implementation notes", href: "https://github.com/CashelF/CashelF.github.io/tree/main/backend/marvin" },
          { label: "CPU benchmark methodology and results", href: "https://github.com/CashelF/CashelF.github.io/tree/main/backend/marvin/benchmarks" },
          { label: "Underlying Qwen3 diffusion checkpoint", href: "https://huggingface.co/dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1" },
          { label: "Hosted Marvin backend", href: "https://huggingface.co/spaces/Cashel/diffusion-chatbot" }
        ]
      }
    ]
  },
  {
    path: "/projects/speaker-adaptation/",
    title: "Support-conditioned LoRA for speaker adaptation",
    category: "RESEARCH · VISUAL SPEECH RECOGNITION",
    description: "Cashel Fitzgerald and Jihyun Kim’s research on gradient-free speaker adaptation for lip reading: support-conditioned LoRA, Auto-AVSR, and LRS2 evaluation results.",
    summary: "Cashel Fitzgerald and Jihyun Kim investigated how a lip-reading model can adapt to an unfamiliar speaker using a short, unlabeled video prefix. A hypernetwork predicts LoRA adapter weights, allowing the frozen Auto-AVSR model to adapt without gradient updates at inference time.",
    credit: "Research with Jihyun Kim · Cornell Tech",
    image: "/AVSRDemo.png",
    imageAlt: "Visual speech recognition research illustration",
    sections: [
      {
        title: "The problem",
        paragraphs: ["Visual speech recognition predicts words from lip motion. A model’s accuracy can change with a speaker’s articulation, camera angle, or recording conditions. The research asks whether a few frames at the start of a clip can provide enough information to personalize a pretrained model without a separate fine-tuning process."]
      },
      {
        title: "Our approach",
        paragraphs: [
          "We kept the Auto-AVSR backbone frozen and introduced low-rank adapters into selected encoder layers. Features from the opening frames condition a hypernetwork, which produces the adapter weights before the full video is decoded.",
          "The paper describes our PyTorch Lightning implementation, adapter placement, conditioning design, and training experiments. Adaptation uses the video prefix without speaker identity labels, additional support clips, or test-time gradient updates."
        ]
      },
      {
        title: "Reported results",
        paragraphs: ["On the LRS2 evaluation described in the paper, word error rate decreased from 51.5% for the unadapted baseline to 49.4%. That is a 2.1 percentage-point decrease, or approximately a 4.1% relative reduction. The hypernetwork used approximately 25.6 million parameters."]
      },
      {
        title: "What did not work, and what remains open",
        paragraphs: [
          "The improvement depended on substantial hypernetwork capacity. Short prefixes contain limited speaker information, and smaller conditioning models did not provide the same gains. An earlier attempt to train a VALLR-style model from scratch suffered from CTC blank collapse, producing mostly empty transcriptions.",
          "These results apply to the configuration and dataset evaluated in the paper. They do not establish comparable gains on other speakers, datasets, or backbones. Longer support sequences and more efficient conditioning are directions for further work."
        ]
      },
      {
        title: "Read the paper",
        paragraphs: ["The full report contains the architecture, experiment details, negative results, and references. It is coauthored by Cashel Fitzgerald and Jihyun Kim."],
        links: [{ label: "Support-Conditioned LoRA for Test-Time Speaker Adaptation in Visual Speech Recognition (PDF)", href: "/Support-Conditioned_LoRA_for_Test-Time_Speaker_Adaptation.pdf" }]
      }
    ]
  },
  {
    path: "/projects/minecraft-rl/",
    title: "Minecraft reinforcement learning",
    category: "REINFORCEMENT LEARNING · AGENT ENVIRONMENTS",
    description: "Cashel Fitzgerald’s Minecraft RL project: a custom combat environment, a learned policy against a scripted opponent, trajectory collection, and PyTorch training.",
    summary: "Minecraft RL is Cashel Fitzgerald’s experiment in training agents for combat in Minecraft. It combines a custom environment, two game clients, an engineered state representation, and a PyTorch training loop.",
    image: "/MinecraftRLDemo.png",
    imageAlt: "Minecraft combat environment used in the reinforcement learning project",
    sections: [
      {
        title: "What I built",
        paragraphs: ["The project connects Minecraft through Malmo and MarLo to a training loop. Its main experiment runs a learned policy against a scripted opponent, with separate game clients participating in the same environment. Supporting code handles environment setup, trajectory storage, model checkpoints, and TensorBoard logging."]
      },
      {
        title: "How the agent sees and acts",
        paragraphs: [
          "The main experiment uses an engineered state representation that includes movement, orientation, health, distance to the opponent, and the angle to the opponent. This gives the policy a compact description of a combat situation rather than asking it to infer all of those properties from pixels.",
          "Action selection combines exploration with predictions from the learned model. The scripted opponent turns toward the learner, approaches it, and attacks when close enough. Stored transitions and sampled replay batches provide data for PyTorch updates."
        ]
      },
      {
        title: "Artifacts and limitations",
        paragraphs: [
          "The repository provides the environment and training code, plus instructions for launching two Minecraft clients. It is a learning experiment in connecting policies, observations, rewards, and a running game.",
          "This write-up does not claim a measured win rate or superiority over another method. The main experiment uses a scripted opponent and engineered observations, so it should not be interpreted as open-ended Minecraft competence or two learning agents performing self-play."
        ]
      },
      {
        title: "Explore the implementation",
        paragraphs: ["The README lists the original environment setup. The main loop and training module show how the two clients, action selection, and updates fit together."],
        links: [
          { label: "Minecraft RL repository and setup", href: "https://github.com/CashelF/rl-minecraft-pvp" },
          { label: "Agent interaction loop", href: "https://github.com/CashelF/rl-minecraft-pvp/blob/main/main.py" },
          { label: "PyTorch training code", href: "https://github.com/CashelF/rl-minecraft-pvp/blob/main/train.py" }
        ]
      }
    ]
  }
];

export const homePage = { path: "/", title: site.title, description: site.description };
export const notFoundPage = { path: "/404.html", title: "Page not found — Cashel Fitzgerald", description: "Find Cashel Fitzgerald’s biography, machine learning projects, and current work at Zomma.", noindex: true };
export const pages = [homePage, ...articles];

export function pageForPath(path) {
  const normalized = path.replace(/\/index\.html$/, "/").replace(/\/$/, "") + "/";
  return pages.find(page => page.path === normalized) || notFoundPage;
}
