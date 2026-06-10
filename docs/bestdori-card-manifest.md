# Bestdori Card Manifest

`/mokoko` and `每日木柜子` can prefer authorized local card image manifests.

Put the manifest at:

```text
data/bestdori-cards.json
```

Supported shape:

```json
{
  "cards": [
    {
      "characterKey": "tomori",
      "characterName": "Takamatsu Tomori",
      "title": "Card title",
      "url": "https://example.com/card-image.png"
    },
    {
      "characterKey": "tomori",
      "characterName": "Takamatsu Tomori",
      "title": "Batch card set",
      "urls": [
        "https://example.com/card-image-1.png",
        "https://example.com/card-image-2.png"
      ],
      "images": [
        "https://example.com/card-image-3.png"
      ]
    }
  ]
}
```

`url`, `urls`, and `images` can be mixed. The bot expands them into one image pool and removes duplicate URLs.

The bot matches `characterKey` first. Known keys:

```text
tomori, anon, rana, soyo, taki, uika, mutsumi, umiri, nyamu, sakiko
```

If multiple cards match the same character, the daily draw rotates through those images by user, chat, and date. If the manifest is missing or an image URL fails, the bot falls back to Bandori Wiki page images and then the local daily card.
