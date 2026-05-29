export type BotResponse =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "options_prompt";
      prompt: string;
      options: Array<{
        id: string;
        title: string;
      }>;
      selectionMode: "single";
      fallbackText?: string;
    }
  | {
      kind: "result_card";
      title: string;
      body: string;
      subtitle?: string;
      imageUrl?: string;
      shareText?: string;
      ctaOptions?: Array<{
        id: string;
        title: string;
      }>;
    }
  | {
      kind: "image";
      imageUrl: string;
      caption?: string;
    }
  | {
      kind: "handoff_state";
      state: string;
      text?: string;
    }
  | {
      kind: "error";
      text: string;
    }
  | {
      kind: "ack";
    }
  | {
      kind: "typing";
    };
