"""CORPUS ULTIMATE — Custom numerical engine: Tensor.

A minimal tensor with automatic differentiation (reverse-mode) for
educational purposes. Not GPU-accelerated.
"""
import math
from typing import List, Optional, Union


class Tensor:
    """A scalar-ish tensor supporting +, *, matmul, and backward().

    Values are stored as nested lists; gradients flow through a graph.
    """

    def __init__(self, data, requires_grad: bool = False, _children=(), _op=""):
        self.data = data
        self.requires_grad = requires_grad
        self.grad = None
        self._backward = lambda: None
        self._prev = set(_children)
        self._op = _op

    @staticmethod
    def _to_list(x):
        if isinstance(x, Tensor):
            return x.data
        return x

    def __add__(self, other):
        other = self._to_list(other)
        out = Tensor(_add(self.data, other), requires_grad=self.requires_grad, _children=(self,), _op="+")

        def _backward():
            if self.requires_grad:
                self.grad = _add(self.grad or _zeros_like(self.data), out.grad or _zeros_like(out.data))
        out._backward = _backward
        return out

    def __mul__(self, other):
        other = self._to_list(other)
        out = Tensor(_mul(self.data, other), requires_grad=self.requires_grad, _children=(self,), _op="*")

        def _backward():
            if self.requires_grad:
                self.grad = _add(self.grad or _zeros_like(self.data),
                                 _mul(out.grad or _zeros_like(out.data), other))
        out._backward = _backward
        return out

    def __rmul__(self, other):
        return self.__mul__(other)

    def matmul(self, other):
        other = self._to_list(other)
        out = Tensor(_matmul(self.data, other), requires_grad=self.requires_grad, _children=(self,), _op="matmul")

        def _backward():
            if self.requires_grad:
                # gradient w.r.t self: out.grad @ other^T
                g = _matmul(out.grad or _zeros_like(out.data), _transpose(other))
                self.grad = _add(self.grad or _zeros_like(self.data), g)
        out._backward = _backward
        return out

    def sum(self):
        s = _sum_all(self.data)
        out = Tensor(s, requires_grad=self.requires_grad, _children=(self,), _op="sum")

        def _backward():
            if self.requires_grad:
                n = _count_elements(self.data)
                self.grad = _add(self.grad or _zeros_like(self.data),
                                 [[1.0 / n for _ in row] for row in self.data])
        out._backward = _backward
        return out

    def backward(self):
        """Reverse-mode autodiff."""
        topo = []
        visited = set()

        def build(v):
            if id(v) not in visited:
                visited.add(id(v))
                for c in v._prev:
                    build(c)
                topo.append(v)

        build(self)
        self.grad = _ones_like(self.data)
        for v in reversed(topo):
            v._backward()

    def __repr__(self):
        return f"Tensor(data={self.data}, grad={self.grad})"


# ---------- helper ops on nested lists ----------

def _zeros_like(x):
    if isinstance(x[0], list):
        return [[0.0 for _ in row] for row in x]
    return [0.0 for _ in x]


def _ones_like(x):
    if isinstance(x[0], list):
        return [[1.0 for _ in row] for row in x]
    return [1.0 for _ in x]


def _add(a, b):
    if isinstance(a[0], list):
        return [[a[i][j] + b[i][j] for j in range(len(a[0]))] for i in range(len(a))]
    return [a[i] + b[i] for i in range(len(a))]


def _mul(a, b):
    if isinstance(a[0], list):
        return [[a[i][j] * b[i][j] for j in range(len(a[0]))] for i in range(len(a))]
    return [a[i] * b[i] for i in range(len(a))]


def _matmul(a, b):
    rows_a, cols_a = len(a), len(a[0])
    rows_b, cols_b = len(b), len(b[0])
    assert cols_a == rows_b, f"matmul shape mismatch: {cols_a} vs {rows_b}"
    out = [[0.0] * cols_b for _ in range(rows_a)]
    for i in range(rows_a):
        for k in range(cols_a):
            aik = a[i][k]
            if aik == 0:
                continue
            for j in range(cols_b):
                out[i][j] += aik * b[k][j]
    return out


def _transpose(a):
    return [[a[i][j] for i in range(len(a))] for j in range(len(a[0]))]


def _sum_all(x):
    if isinstance(x[0], list):
        return sum(_sum_all(row) for row in x)
    return sum(x)


def _count_elements(x):
    if isinstance(x[0], list):
        return sum(_count_elements(row) for row in x)
    return len(x)