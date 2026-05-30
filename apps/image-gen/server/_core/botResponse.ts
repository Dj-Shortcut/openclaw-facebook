export type ConversationAction = {
  id: string;
  label: string;
};

export type ImageOutput = {
  imageUrl: string;
  caption?: string;
};

export type ConversationResponse = {
  text?: string;
  images?: ImageOutput[];
  actions?: ConversationAction[];
};

export type BotResponse =
  | ConversationResponse
  | {
      kind: "text";
      text: string;
      actions?: ConversationAction[];
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
