"""Unit tests for the CorpusTokenizer."""
import pytest
from corpus_engine.tokenizer.tokenizer import CorpusTokenizer


def test_tokenizer_train_encode_decode():
    tok = CorpusTokenizer(vocab_size=100)
    texts = ["hello world", "world of corpus", "hello corpus world"]
    tok.train(texts)
    assert tok.get_vocab_size() > 0
    ids = tok.encode("hello world")
    assert len(ids) > 0
    text = tok.decode(ids)
    assert isinstance(text, str)


def test_tokenizer_special_tokens():
    tok = CorpusTokenizer(vocab_size=100)
    assert "<pad>" in tok.special_tokens
    assert " recated" not in tok.special_tokens
    ids = tok.encode("test")
    assert ids[0] == tok.special_tokens["<bos>"]
    assert ids[-1] == tok.special_tokens["<eos>"]


def test_tokenizer_save_load(tmp_path):
    tok = CorpusTokenizer(vocab_size=100)
    tok.train(["abc def", "def abc"])
    path = tmp_path / "tok.json"
    tok.save(str(path))
    tok2 = CorpusTokenizer.load(str(path))
    assert tok2.get_vocab_size() == tok.get_vocab_size()
    assert tok2.encode("abc") == tok.encode("abc")