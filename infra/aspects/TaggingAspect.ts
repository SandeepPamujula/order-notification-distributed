import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

// ---------------------------------------------------------------------------
// TaggingAspect — enforces mandatory tags on every CDK resource
// ---------------------------------------------------------------------------

export interface TaggingAspectProps {
    /** Environment name: dev | staging | prod */
    readonly env: string;
    /** Service name: e.g. order-service, notification-service, shared */
    readonly service: string;
    /** Owner: e.g. platform-team */
    readonly owner: string;
}

/**
 * CDK Aspect that applies mandatory resource tags to every construct in scope.
 *
 * Apply at `App` level to tag **all** stacks and resources:
 * ```ts
 * cdk.Aspects.of(app).add(new TaggingAspect({ env, service, owner }));
 * ```
 *
 * Per-service stacks can override the `service` tag by applying an additional
 * `TaggingAspect` at the stack level with a more specific `service` value.
 */
export class TaggingAspect implements cdk.IAspect {
    constructor(private readonly props: TaggingAspectProps) { }

    /**
     * Called by the CDK framework once per construct node during synthesis.
     * Tags are applied to every `CfnResource` in the tree.
     */
    public visit(node: IConstruct): void {
        if (cdk.TagManager.isTaggable(node)) {
            node.tags.setTag('env', this.props.env);
            node.tags.setTag('service', this.props.service);
            node.tags.setTag('owner', this.props.owner);
        }
    }
}
