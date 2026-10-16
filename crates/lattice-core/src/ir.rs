//! Article IR: the canonical, provider-independent representation of an article.
//! Rendering, translation, search and embedding all consume this, never raw HTML.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ArticleMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub site_name: Option<String>,
    pub published_at: Option<String>,
    pub language: Option<String>,
    pub canonical_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Heading,
    Paragraph,
    ListItem,
    Blockquote,
    Code,
    Table,
    Image,
    Caption,
}

impl BlockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Heading => "heading",
            Self::Paragraph => "paragraph",
            Self::ListItem => "list_item",
            Self::Blockquote => "blockquote",
            Self::Code => "code",
            Self::Table => "table",
            Self::Image => "image",
            Self::Caption => "caption",
        }
    }
}

/// Inline run inside a prose block. Kept deliberately small: links and inline code
/// matter for technical text; emphasis is flattened to text for now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Inline {
    Text { v: String },
    Code { v: String },
    Link { v: String, href: String },
}

/// Kind-specific attributes. Only the fields relevant to the kind are set.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BlockAttrs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    pub kind: BlockKind,
    /// Plain text: the unit for search, hashing and translation.
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub inlines: Vec<Inline>,
    #[serde(default)]
    pub attrs: BlockAttrs,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ArticleIr {
    pub meta: ArticleMeta,
    pub blocks: Vec<Block>,
}
