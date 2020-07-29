import { Component, createElement, options, Fragment } from 'preact';
import { assign } from './util';

const oldCatchError = options._catchError;
options._catchError = function(error, newVNode, oldVNode) {
	if (error.then) {
		/** @type {import('./internal').Component} */
		let component;
		let vnode = newVNode;

		for (; (vnode = vnode._parent); ) {
			if ((component = vnode._component) && component._childDidSuspend) {
				if (newVNode._dom == null) {
					newVNode._dom = oldVNode._dom;
					newVNode._children = oldVNode._children;
				}
				// Don't call oldCatchError if we found a Suspense
				return component._childDidSuspend(error, newVNode._component);
			}
		}
	}
	oldCatchError(error, newVNode, oldVNode);
};

const oldDiffed = options.diffed;
options.diffed = function(newVNode) {
	if (newVNode._component) {
		newVNode._component._isSuspended = false;
	}
	oldDiffed(newVNode);
};

function detachedClone(vnode) {
	if (vnode) {
		vnode = assign({}, vnode);
		if (vnode._component != null) {
			vnode._component._isSuspended = true;
			vnode._component = null;
		}
		vnode._children = vnode._children && vnode._children.map(detachedClone);
	}
	return vnode;
}

function removeOriginal(vnode) {
	if (vnode) {
		vnode._original = null;
		vnode._children = vnode._children && vnode._children.map(removeOriginal);
	}
	return vnode;
}

// having custom inheritance instead of a class here saves a lot of bytes
export function Suspense() {
	// we do not call super here to golf some bytes...
	this._pendingSuspensionCount = 0;
	this._suspenders = null;
	this._detachOnNextRender = null;
}

// Things we do here to save some bytes but are not proper JS inheritance:
// - call `new Component()` as the prototype
// - do not set `Suspense.prototype.constructor` to `Suspense`
Suspense.prototype = new Component();

/**
 * @param {Promise} promise The thrown promise
 * @param {Component<any, any>} suspendingComponent The suspending component
 */
Suspense.prototype._childDidSuspend = function(promise, suspendingComponent) {
	/** @type {import('./internal').SuspenseComponent} */
	const c = this;
	if (c._suspenders == null) {
		c._suspenders = [];
	}
	c._suspenders.push(suspendingComponent);

	const resolve = suspended(c._vnode);

	let resolved = false;
	const onResolved = () => {
		if (resolved) return;

		resolved = true;
		suspendingComponent.componentWillUnmount =
			suspendingComponent._suspendedComponentWillUnmount;

		if (resolve) {
			resolve(onSuspensionComplete);
		} else {
			onSuspensionComplete();
		}
	};

	suspendingComponent._suspendedComponentWillUnmount =
		suspendingComponent.componentWillUnmount;
	suspendingComponent.componentWillUnmount = () => {
		onResolved();

		if (suspendingComponent._suspendedComponentWillUnmount) {
			suspendingComponent._suspendedComponentWillUnmount();
		}
	};

	const onSuspensionComplete = () => {
		if (!--c._pendingSuspensionCount) {
			c._vnode._children[0] = removeOriginal(c.state._suspended);
			c.setState({ _suspended: (c._detachOnNextRender = null) });

			let suspended;
			while ((suspended = c._suspenders.pop())) {
				suspended.forceUpdate();
			}
		}
	};

	if (!c._pendingSuspensionCount++) {
		c.setState({ _suspended: (c._detachOnNextRender = c._vnode._children[0]) });
	}
	promise.then(onResolved, onResolved);
};

Suspense.prototype.render = function(props, state) {
	if (this._detachOnNextRender) {
		// When the Suspense's _vnode was created by a call to createVNode
		// (i.e. due to a setState further up in the tree)
		// it's _children prop is null, in this case we "forget" about the parked vnodes to detach
		if (this._vnode._children)
			this._vnode._children[0] = detachedClone(this._detachOnNextRender);
		this._detachOnNextRender = null;
	}

	return [
		createElement(Fragment, null, state._suspended ? null : props.children),
		state._suspended && props.fallback
	];
};

/**
 * Checks and calls the parent component's _suspended method, passing in the
 * suspended vnode. This is a way for a parent (e.g. SuspenseList) to get notified
 * that one of its children/descendants suspended.
 *
 * The parent MAY return a callback. The callback will get called when the
 * suspension resolves, notifying the parent of the fact.
 * Moreover, the callback gets function `unsuspend` as a parameter. The resolved
 * child descendant will not actually get unsuspended until `unsuspend` gets called.
 * This is a way for the parent to delay unsuspending.
 *
 * If the parent does not return a callback then the resolved vnode
 * gets unsuspended immediately when it resolves.
 *
 * @param {import('../src/internal').VNode} vnode
 * @returns {((unsuspend: () => void) => void)?}
 */
export function suspended(vnode) {
	let component = vnode._parent._component;
	return component && component._suspended && component._suspended(vnode);
}

export function lazy(loader) {
	let prom;
	let component;
	let error;

	function Lazy(props) {
		if (!prom) {
			prom = loader();
			prom.then(
				exports => {
					component = exports.default || exports;
				},
				e => {
					error = e;
				}
			);
		}

		if (error) {
			throw error;
		}

		if (!component) {
			throw prom;
		}

		return createElement(component, props);
	}

	Lazy.displayName = 'Lazy';
	Lazy._forwarded = true;
	return Lazy;
}
