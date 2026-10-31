"""List prices in USD per million tokens, to show spend as a list-price estimate.

Your plan is a subscription, so this is not a bill. Source: Anthropic's model price table (input, output, cache read)
and its prompt-caching page (cache writes cost 1.25x input for the 5-minute TTL and 2x input for the 1-hour TTL),
as cached on 2026-10-06. A model not listed here gets tokens counted and no dollar figure.
"""

PRICES_AS_OF = "2026-10-06"

# model: (input, output, cache write 5m, cache write 1h, cache read)
PRICES: dict[str, tuple[float, float, float, float, float]] = {
    "claude-fable-5-1": (10.00, 50.00, 12.50, 20.00, 0.25),
    "claude-fable-5": (10.00, 50.00, 12.50, 20.00, 1.00),
    "claude-opus-5-5": (4.00, 20.00, 5.00, 8.00, 0.20),
    "claude-opus-5": (5.00, 25.00, 6.25, 10.00, 0.50),
    "claude-opus-4-8": (5.00, 25.00, 6.25, 10.00, 0.50),
    "claude-opus-4-7": (5.00, 25.00, 6.25, 10.00, 0.50),
    "claude-opus-4-6": (5.00, 25.00, 6.25, 10.00, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00, 2.50, 4.00, 0.20),
    "claude-sonnet-5": (2.00, 10.00, 2.50, 4.00, 0.20),
    "claude-sonnet-4-6": (3.00, 15.00, 3.75, 6.00, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.125, 0.20, 0.01),
    "claude-haiku-4-5": (1.00, 5.00, 1.25, 2.00, 0.10),
}


def cost(model: str, inp: int, out: int, w5: int, w1h: int, read: int) -> float | None:
    """Dollar estimate for one message's tokens, or None when the model has no listed price."""
    p = PRICES.get(model)
    if p is None:
        return None
    return (inp * p[0] + out * p[1] + w5 * p[2] + w1h * p[3] + read * p[4]) / 1_000_000
